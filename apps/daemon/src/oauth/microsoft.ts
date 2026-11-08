/**
 * Microsoft 365 / Outlook.com account connection (architecture §12), the same shape as Google's:
 * `POST /accounts/oauth/microsoft/start` returns the consent URL on the `common` authority (personal
 * and work or school accounts); Microsoft sends the browser back to `GET /oauth/microsoft/callback`,
 * which exchanges the code and connects the account, or reconnects it when this user already
 * connected the same identity (`${tid}:${oid}` from the ID token) in the tenant. The browser lands
 * on `returnTo?accountId=…`, or `returnTo?error=<code>`.
 *
 * As with Google, the callback needs the same signed-in user who started the flow.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { withTenant } from '@supercal/db';
import { idTokenClaims, MICROSOFT_AUTHORITY, MICROSOFT_SCOPES, OAuthError, tokenRequest, type MicrosoftCredentials } from '@supercal/providers';
import { BadRequest, createApiApp, problemResponses, Unprocessable } from '../api/kit/index.ts';
import type { Principal } from '../auth/principal.ts';
import { connectAccount, findOwnAccount, reconnectAccount } from '../sync/accounts.ts';
import type { SyncDeps } from '../sync/index.ts';
import { allowedReturnTo, beginFlow, CallbackFailure, errorCode, redirectWith, takeFlow, type OAuthClient, type OAuthDeps } from './common.ts';
import { AuthorizationUrl, OAuthStart } from './google.ts';

export const MICROSOFT_AUTHORIZE_URL = `${MICROSOFT_AUTHORITY}/authorize`;
const CALENDARS_READ = 'Calendars.Read';
const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/';
const EXCHANGE_TIMEOUT_MS = 30_000;

/** Work accounts may lack `email`; `preferred_username` is then the sign-in address. */
const IdClaims = z.object({
  oid: z.string().min(1),
  tid: z.string().min(1),
  aud: z.string(),
  iss: z.string(),
  email: z.string().min(1).optional(),
  preferred_username: z.string().min(1).optional(),
});

export const callbackPath = '/api/v1/oauth/microsoft/callback';
const redirectUri = (oauth: OAuthDeps) => new URL(callbackPath, oauth.publicUrl).href;

function microsoftClient(oauth: OAuthDeps): OAuthClient {
  if (!oauth.microsoft) throw new Unprocessable('Microsoft accounts are not enabled on this server (MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET)', 'unsupported-provider');
  return oauth.microsoft;
}

/** The consent URL for the principal; `loginHint` preselects the account on reconnect. 400 when `returnTo` is not ours. */
export async function startMicrosoftFlow(oauth: OAuthDeps, principal: Principal, returnTo: string, loginHint?: string | null): Promise<string> {
  const client = microsoftClient(oauth);
  const target = allowedReturnTo(returnTo, oauth.returnOrigins);
  if (!target) throw new BadRequest([{ path: 'returnTo', message: `must be a path on ${oauth.returnOrigins.join(' or ')}` }]);
  const { userId, tenantId } = principal;
  const { flowId, challenge } = await withTenant(tenantId, (tx) => beginFlow(tx, { tenantId, userId, provider: 'microsoft' }));
  const url = new URL(client.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(oauth),
    response_type: 'code',
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: oauth.state.sign({ provider: 'microsoft', userId, tenantId, flowId, returnTo: target }),
    ...(loginHint ? { login_hint: loginHint } : { prompt: 'select_account' }),
  }).toString();
  return url.href;
}

type CallbackQuery = { code?: string | undefined; state?: string | undefined; error?: string | undefined };

/** Exchanges the code and reads the Microsoft identity; every failure is a `CallbackFailure`. */
async function exchange(oauth: OAuthDeps, client: OAuthClient, code: string, verifier: string): Promise<MicrosoftCredentials> {
  const token = await tokenRequest(
    client.tokenUrl,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(oauth),
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: verifier,
      scope: MICROSOFT_SCOPES.join(' '),
    },
    AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  ).catch((error: unknown) => {
    throw new CallbackFailure(error instanceof OAuthError ? errorCode(error.code, 'exchange_failed') : 'exchange_failed');
  });
  // Graph scopes come back with or without their resource prefix.
  const scopes = (token.scope?.split(' ') ?? []).map((s) => (s.startsWith(GRAPH_SCOPE_PREFIX) ? s.slice(GRAPH_SCOPE_PREFIX.length) : s));
  if (!scopes.includes(CALENDARS_READ)) throw new CallbackFailure('missing_scopes');
  if (!token.refresh_token) throw new CallbackFailure('no_refresh_token');
  const claims = IdClaims.safeParse(token.id_token ? idTokenClaims(token.id_token) : null);
  if (!claims.success) throw new CallbackFailure('invalid_id_token');
  const { oid, tid, aud, iss, email, preferred_username } = claims.data;
  const address = email ?? preferred_username;
  if (aud !== client.clientId || iss !== `https://login.microsoftonline.com/${tid}/v2.0` || !address) throw new CallbackFailure('invalid_id_token');
  return {
    provider: 'microsoft',
    subject: `${tid}:${oid}`,
    email: address,
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    refreshToken: token.refresh_token,
  };
}

/**
 * Handles Microsoft's redirect and returns where to send the browser. A missing, tampered or
 * expired `state` is a 400: without it there is no trustworthy `returnTo` to redirect to.
 */
export async function completeMicrosoftFlow(oauth: OAuthDeps, sync: SyncDeps, principal: Principal, query: CallbackQuery): Promise<string> {
  const state = oauth.state.verify(query.state);
  if (!state || state.provider !== 'microsoft') throw new BadRequest([{ path: 'state', message: 'is invalid or expired' }], 'Invalid OAuth state');
  try {
    if (principal.userId !== state.userId || principal.tenantId !== state.tenantId) throw new CallbackFailure('session_mismatch');
    const verifier = await withTenant(state.tenantId, (tx) => takeFlow(tx, state));
    if (!verifier) throw new CallbackFailure('flow_expired');
    if (query.error) throw new CallbackFailure(errorCode(query.error, 'access_denied'));
    if (!query.code) throw new CallbackFailure('missing_code');
    const credentials = await exchange(oauth, microsoftClient(oauth), query.code, verifier);
    const existing = await findOwnAccount(principal, 'microsoft', credentials.subject);
    const account = existing
      ? await reconnectAccount(sync, principal, existing.id, credentials, { email: credentials.email })
      : (await connectAccount(sync, principal, { credentials, displayName: credentials.email, email: credentials.email, providerSubject: credentials.subject })).account;
    return redirectWith(state.returnTo, { accountId: account.id });
  } catch (error) {
    if (error instanceof CallbackFailure) return redirectWith(state.returnTo, { error: error.code });
    sync.log.warn('Microsoft account connection failed', { error });
    return redirectWith(state.returnTo, { error: 'connect_failed' });
  }
}

const tags = ['Accounts'];

const startRoute = createRoute({
  method: 'post',
  path: '/api/v1/accounts/oauth/microsoft/start',
  operationId: 'startMicrosoftOAuth',
  tags,
  request: { body: { required: true, content: { 'application/json': { schema: OAuthStart } } } },
  responses: {
    200: { description: 'Send the browser to this Microsoft consent URL', content: { 'application/json': { schema: AuthorizationUrl } } },
    ...problemResponses(400, 401, 403, 422),
  },
});

const callbackRoute = createRoute({
  method: 'get',
  path: callbackPath,
  operationId: 'microsoftOAuthCallback',
  tags,
  request: { query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  responses: {
    302: { description: 'Back to `returnTo`, with `accountId` on success or `error` (e.g. `access_denied`, `missing_scopes`, `flow_expired`)' },
    ...problemResponses(400, 401, 403),
  },
});

export const microsoftOAuthRoutes = createApiApp()
  .openapi(startRoute, async (c) => {
    const authorizationUrl = await startMicrosoftFlow(c.var.oauth, c.var.principal, c.req.valid('json').returnTo);
    return c.json({ authorizationUrl }, 200);
  })
  .openapi(callbackRoute, async (c) => c.redirect(await completeMicrosoftFlow(c.var.oauth, c.var.sync, c.var.principal, c.req.valid('query')), 302));
