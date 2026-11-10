/**
 * Google account connection (architecture §12): `POST /accounts/oauth/google/start` returns the
 * consent URL; Google sends the browser back to `GET /oauth/google/callback`, which exchanges the
 * code, then connects the account through the shared flow, or, when this user already connected
 * the same Google identity (`sub`) in the tenant, updates that account's credentials (reconnect).
 * The browser lands on `returnTo?accountId=…`, or `returnTo?error=<code>`.
 *
 * The callback needs the same signed-in user who started the flow: otherwise someone could start a
 * flow and get a victim to complete it, connecting the victim's calendar to their account.
 *
 * Incremental consent (editing and sinks): `startGoogleFlow(…, { accountId, scopes })` asks for extra scopes on
 * top of those already granted (`include_granted_scopes`). The callback then only updates that
 * account; if the user signs in as another Google identity it fails with `account_mismatch`, and
 * if they untick an extra scope with `consent_declined`, leaving the account as it was.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { withTenant, type AccountId } from '@supercal/db';
import { GOOGLE_EVENTS_WRITE_SCOPE, idTokenClaims, OAuthError, tokenRequest, type GoogleCredentials } from '@supercal/providers';
import { BadRequest, createApiApp, problemResponses, Unprocessable } from '../api/kit/index.ts';
import type { Principal } from '../auth/principal.ts';
import { connectAccount, findOwnAccount, reconnectAccount } from '../sync/accounts.ts';
import type { SyncDeps } from '../sync/index.ts';
import { allowedReturnTo, beginFlow, redirectWith, takeFlow, type OAuthClient, type OAuthDeps } from './common.ts';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const EVENTS_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CALENDAR_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const GOOGLE_SCOPES = ['openid', 'email', CALENDAR_LIST_SCOPE, GOOGLE_EVENTS_WRITE_SCOPE];
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const EXCHANGE_TIMEOUT_MS = 30_000;

const IdClaims = z.object({ sub: z.string().min(1), email: z.string().min(1), aud: z.string(), iss: z.string() });

export const callbackPath = '/api/v1/oauth/google/callback';
const redirectUri = (oauth: OAuthDeps) => new URL(callbackPath, oauth.publicUrl).href;

function googleClient(oauth: OAuthDeps): OAuthClient {
  if (!oauth.google) throw new Unprocessable('Google accounts are not enabled on this server (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)', 'unsupported-provider');
  return oauth.google;
}

/** Extra scopes for one existing account (incremental consent). */
export type ConsentRequest = { accountId: AccountId; scopes: string[] };

/**
 * The consent URL for the principal; `loginHint` preselects the Google account on reconnect, and
 * `consent` asks for extra scopes for an existing account. 400 when `returnTo` is not ours.
 */
export async function startGoogleFlow(oauth: OAuthDeps, principal: Principal, returnTo: string, loginHint?: string | null, consent?: ConsentRequest): Promise<string> {
  const client = googleClient(oauth);
  const target = allowedReturnTo(returnTo, oauth.returnOrigins);
  if (!target) throw new BadRequest([{ path: 'returnTo', message: `must be a path on ${oauth.returnOrigins.join(' or ')}` }]);
  const { userId, tenantId } = principal;
  const { flowId, challenge } = await withTenant(tenantId, (tx) => beginFlow(tx, { tenantId, userId, provider: 'google' }));
  const url = new URL(client.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(oauth),
    response_type: 'code',
    scope: [...new Set([...GOOGLE_SCOPES, ...(consent?.scopes ?? [])])].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: oauth.state.sign({ provider: 'google', userId, tenantId, flowId, returnTo: target, ...(consent && { consent }) }),
    ...(loginHint && { login_hint: loginHint }),
  }).toString();
  return url.href;
}

type CallbackQuery = { code?: string | undefined; state?: string | undefined; error?: string | undefined };

/** Thrown inside the callback for a failure the browser is sent back with, as `error=<code>`. */
class CallbackFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Exchanges the code and reads the Google identity; every failure is a `CallbackFailure`. */
async function exchange(oauth: OAuthDeps, client: OAuthClient, code: string, verifier: string): Promise<GoogleCredentials> {
  const token = await tokenRequest(
    client.tokenUrl,
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri(oauth), client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier },
    AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  ).catch((error: unknown) => {
    throw new CallbackFailure(error instanceof OAuthError ? error.code.replace(/[^a-z0-9_]/g, '') || 'exchange_failed' : 'exchange_failed');
  });
  const scopes = token.scope?.split(' ') ?? [];
  // Google's granular consent lets the user untick either calendar scope.
  if ((!scopes.includes(GOOGLE_EVENTS_WRITE_SCOPE) && !scopes.includes(EVENTS_READ_SCOPE)) || !scopes.includes(CALENDAR_LIST_SCOPE)) throw new CallbackFailure('missing_scopes');
  if (!token.refresh_token) throw new CallbackFailure('no_refresh_token');
  const claims = IdClaims.safeParse(token.id_token ? idTokenClaims(token.id_token) : null);
  if (!claims.success || claims.data.aud !== client.clientId || !ISSUERS.has(claims.data.iss)) throw new CallbackFailure('invalid_id_token');
  return {
    provider: 'google',
    sub: claims.data.sub,
    email: claims.data.email,
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    refreshToken: token.refresh_token,
    scopes,
  };
}

/**
 * Handles Google's redirect and returns where to send the browser. A missing, tampered or expired
 * `state` is a 400: without it there is no trustworthy `returnTo` to redirect to.
 */
export async function completeGoogleFlow(oauth: OAuthDeps, sync: SyncDeps, principal: Principal, query: CallbackQuery): Promise<string> {
  const state = oauth.state.verify(query.state);
  if (!state || state.provider !== 'google') throw new BadRequest([{ path: 'state', message: 'is invalid or expired' }], 'Invalid OAuth state');
  try {
    if (principal.userId !== state.userId || principal.tenantId !== state.tenantId) throw new CallbackFailure('session_mismatch');
    const verifier = await withTenant(state.tenantId, (tx) => takeFlow(tx, state));
    if (!verifier) throw new CallbackFailure('flow_expired');
    if (query.error) throw new CallbackFailure(query.error.replace(/[^a-z0-9_]/g, '') || 'access_denied');
    if (!query.code) throw new CallbackFailure('missing_code');
    const credentials = await exchange(oauth, googleClient(oauth), query.code, verifier);
    const existing = await findOwnAccount(principal, 'google', credentials.sub);
    if (state.consent) {
      if (existing?.id !== state.consent.accountId) throw new CallbackFailure('account_mismatch');
      if (!state.consent.scopes.every((scope) => credentials.scopes.includes(scope))) throw new CallbackFailure('consent_declined');
    }
    const account = existing
      ? await reconnectAccount(sync, principal, existing.id, credentials, { email: credentials.email })
      : (await connectAccount(sync, principal, { credentials, displayName: credentials.email, email: credentials.email, providerSubject: credentials.sub })).account;
    return redirectWith(state.returnTo, { accountId: account.id });
  } catch (error) {
    if (error instanceof CallbackFailure) return redirectWith(state.returnTo, { error: error.code });
    sync.log.warn('Google account connection failed', { error });
    return redirectWith(state.returnTo, { error: 'connect_failed' });
  }
}

const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Accounts'];

export const OAuthStart = z
  .object({ returnTo: z.string().min(1).max(2048).openapi({ description: 'A path (or URL) on this server to send the browser back to', example: '/accounts' }) })
  .openapi('OAuthStart');
export const AuthorizationUrl = z.object({ authorizationUrl: z.url() }).openapi('AuthorizationUrl');

const startRoute = createRoute({
  method: 'post',
  path: '/api/v1/accounts/oauth/google/start',
  operationId: 'startGoogleOAuth',
  tags,
  request: { body: { required: true, content: { 'application/json': { schema: OAuthStart } } } },
  responses: { 200: json('Send the browser to this Google consent URL', AuthorizationUrl), ...problemResponses(400, 401, 403, 422) },
});

const callbackRoute = createRoute({
  method: 'get',
  path: callbackPath,
  operationId: 'googleOAuthCallback',
  tags,
  request: { query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  responses: {
    302: { description: 'Back to `returnTo`, with `accountId` on success or `error` (e.g. `access_denied`, `missing_scopes`, `flow_expired`, and for incremental consent `consent_declined`, `account_mismatch`)' },
    ...problemResponses(400, 401, 403),
  },
});

export const googleOAuthRoutes = createApiApp()
  .openapi(startRoute, async (c) => {
    const authorizationUrl = await startGoogleFlow(c.var.oauth, c.var.principal, c.req.valid('json').returnTo);
    return c.json({ authorizationUrl }, 200);
  })
  .openapi(callbackRoute, async (c) => c.redirect(await completeGoogleFlow(c.var.oauth, c.var.sync, c.var.principal, c.req.valid('query')), 302));
