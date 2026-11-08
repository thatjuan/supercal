/**
 * Calendar accounts (architecture §12). `POST /accounts` is a discriminated union on `provider`:
 * each credential-based provider adds its variant to `NewAccount` and its mapping to `fromInput`
 * (OAuth providers connect through their own start/callback flow in `oauth/`, and reconnect
 * through `POST /accounts/{id}/reconnect`; the others through `PUT /accounts/{id}/credentials`).
 * Either way the shared flow in `sync/accounts.ts` proves the credentials by listing calendars
 * before anything is stored.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { CONNECTED_PROVIDERS, calendarAccount, connectionStatus, withTenant, type CalendarAccount } from '@supercal/db';
import { AuthFailedError, EgressBlockedError, ICLOUD_SERVER_URL, ProviderThrottledError, ProviderUnavailableError, UnsupportedAuthError } from '@supercal/providers';
import { and, asc, eq, ne } from 'drizzle-orm';
import { hasRole } from '../auth/policy.ts';
import { NoAdapterError } from '../sync/context.ts';
import { connectAccount, deleteAccount, loadAccount, replaceCredentials, requestSync, updateAccount, type NewAccount as NewAccountInput } from '../sync/accounts.ts';
import { AuthorizationUrl, OAuthStart, startGoogleFlow } from '../oauth/google.ts';
import { startMicrosoftFlow } from '../oauth/microsoft.ts';
import { Calendar, toCalendars } from './calendars.ts';
import { createApiApp, etagOf, ifMatchHeaders, ProblemError, problemResponses, requireIfMatch, typeId, Unprocessable } from './kit/index.ts';

const Account = z
  .object({
    id: typeId('acc'),
    provider: z.enum(CONNECTED_PROVIDERS),
    ownerUserId: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    serverUrl: z.string().nullable().openapi({ description: 'For ICS accounts only the host: the URL is a secret' }),
    status: z.enum(connectionStatus.enumValues),
    statusDetail: z.string().nullable(),
    autoPublish: z.boolean().openapi({ description: 'Newly discovered calendars are published enabled' }),
  })
  .openapi('Account');
const AccountList = z.object({ items: z.array(Account) }).openapi('AccountList');
const ConnectedAccount = z.object({ account: Account, calendars: z.array(Calendar) }).openapi('ConnectedAccount');

const DisplayName = z.string().min(1).max(100);

const NewIcsAccount = z
  .object({
    provider: z.literal('ics'),
    url: z.url({ protocol: /^(https?|webcal)$/ }).openapi({ description: 'An ICS or webcal URL; stored encrypted' }),
    displayName: DisplayName.optional(),
  })
  .openapi('NewIcsAccount');

const NewCaldavAccount = z
  .object({
    provider: z.literal('caldav'),
    serverUrl: z.url({ protocol: /^https?$/ }).openapi({ description: 'The CalDAV server; discovery starts at its /.well-known/caldav' }),
    username: z.string().min(1),
    password: z.string().min(1).openapi({ description: 'Basic auth only; stored encrypted' }),
    displayName: DisplayName.optional(),
  })
  .openapi('NewCaldavAccount');

const NewIcloudAccount = z
  .object({
    provider: z.literal('icloud'),
    appleId: z.string().min(1),
    appSpecificPassword: z.string().min(1).openapi({ description: 'An app-specific password from appleid.apple.com; stored encrypted' }),
  })
  .openapi('NewIcloudAccount');

const NewAccount = z.discriminatedUnion('provider', [NewIcsAccount, NewCaldavAccount, NewIcloudAccount]).openapi('NewAccount');
type NewAccount = z.infer<typeof NewAccount>;

type Variants = { [P in NewAccount['provider']]: Extract<NewAccount, { provider: P }> };

/** Each variant's credentials and account columns. */
const fromInput: { [P in keyof Variants]: (input: Variants[P]) => NewAccountInput } = {
  ics: ({ url, displayName }) => {
    const host = new URL(url).host;
    return { credentials: { provider: 'ics', url }, displayName: displayName ?? host, serverUrl: host };
  },
  caldav: ({ serverUrl, username, password, displayName }) => ({
    credentials: { provider: 'caldav', serverUrl, username, password },
    displayName: displayName ?? `${username} on ${new URL(serverUrl).host}`,
    serverUrl,
  }),
  icloud: ({ appleId, appSpecificPassword }) => ({
    credentials: { provider: 'icloud', appleId, appSpecificPassword },
    displayName: 'iCloud',
    email: appleId.includes('@') ? appleId : null,
    serverUrl: ICLOUD_SERVER_URL,
  }),
};
const accountInput = <P extends keyof Variants>(provider: P, input: Variants[P]) => fromInput[provider](input);

/**
 * New credentials for a connected account, of its own provider: a rotated ICS link, a CalDAV login
 * (on the same server) or an iCloud app-specific password.
 */
const CredentialsUpdate = z
  .discriminatedUnion('provider', [
    z.object({ provider: z.literal('ics'), url: NewIcsAccount.shape.url }),
    z.object({ provider: z.literal('caldav'), username: NewCaldavAccount.shape.username, password: NewCaldavAccount.shape.password }),
    z.object({ provider: z.literal('icloud'), appleId: NewIcloudAccount.shape.appleId, appSpecificPassword: NewIcloudAccount.shape.appSpecificPassword }),
  ])
  .openapi('CredentialsUpdate');
type CredentialsUpdate = z.infer<typeof CredentialsUpdate>;

/** The new credentials and account columns for `input`, or a 422 when it names another provider. */
function credentialsFor(account: CalendarAccount, input: CredentialsUpdate) {
  if (input.provider !== account.provider) throw new Unprocessable(`This is a ${account.provider} account, not ${input.provider}`, 'provider-mismatch');
  if (input.provider === 'ics') {
    const { credentials, serverUrl } = fromInput.ics(input);
    return { credentials, email: account.email, serverUrl: serverUrl ?? null };
  }
  if (input.provider === 'icloud') {
    const { credentials, email } = fromInput.icloud(input);
    return { credentials, email: email ?? null, serverUrl: account.serverUrl };
  }
  if (!account.serverUrl) throw new Error(`caldav account ${account.id} has no server URL`);
  return { credentials: fromInput.caldav({ ...input, serverUrl: account.serverUrl }).credentials, email: account.email, serverUrl: account.serverUrl };
}

const AccountPatch = z.object({ displayName: DisplayName.optional(), autoPublish: z.boolean().optional() });

const toAccount = ({ id, provider, ownerUserId, displayName, email, serverUrl, status, statusDetail, autoPublish }: CalendarAccount) => {
  if (provider === 'hosted') throw new Error('Hosted accounts are hidden');
  return {
    id,
    provider,
    ownerUserId,
    displayName,
    email,
    serverUrl,
    status,
    statusDetail,
    autoPublish,
  };
};

const APPLE_APP_PASSWORDS = 'https://support.apple.com/en-us/102654';

/**
 * Provider failures while connecting, as problems: rejected credentials are a 422
 * `invalid-credentials` (for iCloud with a pointer to app-specific passwords), and a server
 * offering only Digest auth a 422 `unsupported-auth`.
 */
function connectProblem(error: unknown, provider: NewAccount['provider']): unknown {
  if (error instanceof UnsupportedAuthError) return new Unprocessable(error.message, 'unsupported-auth');
  if (error instanceof AuthFailedError && provider === 'icloud')
    return new Unprocessable(`iCloud rejected the credentials: ${error.message}. Use an app-specific password, not your Apple ID password: ${APPLE_APP_PASSWORDS}`, 'invalid-credentials');
  if (error instanceof AuthFailedError) return new Unprocessable(`The provider rejected the credentials: ${error.message}`, 'invalid-credentials');
  if (error instanceof EgressBlockedError) return new Unprocessable(error.message, 'egress-blocked');
  if (error instanceof NoAdapterError) return new Unprocessable(error.message, 'unsupported-provider');
  if (error instanceof ProviderUnavailableError || error instanceof ProviderThrottledError) return new ProblemError(503, error.message, undefined, 'provider-unavailable');
  return error;
}

const params = z.object({ id: typeId('acc') });
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Accounts'];

const listAccounts = createRoute({
  method: 'get',
  path: '/api/v1/accounts',
  operationId: 'listAccounts',
  tags,
  responses: { 200: json('Your accounts; for admins, every account in the tenant', AccountList), ...problemResponses(401, 403) },
});

const createAccount = createRoute({
  method: 'post',
  path: '/api/v1/accounts',
  operationId: 'createAccount',
  tags,
  request: { body: { required: true, content: { 'application/json': { schema: NewAccount } } } },
  responses: {
    201: json('The account and its calendars, each published in your default feed', ConnectedAccount),
    ...problemResponses(400, 401, 403, 422, 503),
  },
});

const getAccount = createRoute({
  method: 'get',
  path: '/api/v1/accounts/{id}',
  operationId: 'getAccount',
  tags,
  request: { params },
  responses: { 200: json('The account', Account), ...problemResponses(400, 401, 403, 404) },
});

const patchAccount = createRoute({
  method: 'patch',
  path: '/api/v1/accounts/{id}',
  operationId: 'updateAccount',
  tags,
  request: { params, headers: ifMatchHeaders, body: { required: true, content: { 'application/json': { schema: AccountPatch } } } },
  responses: { 200: json('The updated account', Account), ...problemResponses(400, 401, 403, 404, 412) },
});

const removeAccount = createRoute({
  method: 'delete',
  path: '/api/v1/accounts/{id}',
  operationId: 'deleteAccount',
  tags,
  request: { params },
  responses: {
    204: { description: 'Disconnected: its calendars and their data are deleted, and the publications they fed are disabled' },
    ...problemResponses(400, 401, 403, 404),
  },
});

const syncAccount = createRoute({
  method: 'post',
  path: '/api/v1/accounts/{id}/sync',
  operationId: 'syncAccount',
  tags,
  request: { params },
  responses: { 202: { description: 'Every calendar of the account syncs now' }, ...problemResponses(400, 401, 403, 404, 429) },
});

const reconnect = createRoute({
  method: 'post',
  path: '/api/v1/accounts/{id}/reconnect',
  operationId: 'reconnectAccount',
  tags,
  request: { params, body: { required: true, content: { 'application/json': { schema: OAuthStart } } } },
  responses: {
    200: json('Send the browser to this consent URL; the callback updates this account when the same identity signs in', AuthorizationUrl),
    ...problemResponses(400, 401, 403, 404, 422),
  },
});

const putCredentials = createRoute({
  method: 'put',
  path: '/api/v1/accounts/{id}/credentials',
  operationId: 'replaceAccountCredentials',
  tags,
  request: { params, body: { required: true, content: { 'application/json': { schema: CredentialsUpdate } } } },
  responses: {
    200: json('Proved by listing calendars, stored, and the account active again; every calendar syncs now', Account),
    ...problemResponses(400, 401, 403, 404, 422, 503),
  },
});

export const accountRoutes = createApiApp()
  .openapi(listAccounts, async (c) => {
    const { principal } = c.var;
    const rows = await withTenant(principal.tenantId, (tx) =>
      tx
        .select()
        .from(calendarAccount)
        .where(and(ne(calendarAccount.provider, 'hosted'), hasRole(principal, 'admin') ? undefined : eq(calendarAccount.ownerUserId, principal.userId)))
        .orderBy(asc(calendarAccount.id)),
    );
    return c.json({ items: rows.map(toAccount) }, 200);
  })
  .openapi(createAccount, async (c) => {
    const input = c.req.valid('json');
    const { principal, sync } = c.var;
    const { account, calendars } = await connectAccount(sync, principal, accountInput(input.provider, input)).catch((error: unknown) => {
      throw connectProblem(error, input.provider);
    });
    const items = await withTenant(principal.tenantId, (tx) => toCalendars(tx, calendars));
    return c.json({ account: toAccount(account), calendars: items }, 201, { ETag: etagOf(account) });
  })
  .openapi(getAccount, async (c) => {
    const { id } = c.req.valid('param');
    const row = await withTenant(c.var.principal.tenantId, (tx) => loadAccount(tx, c.var.principal, id));
    return c.json(toAccount(row), 200, { ETag: etagOf(row) });
  })
  .openapi(patchAccount, async (c) => {
    const { id } = c.req.valid('param');
    const row = await updateAccount(c.var.principal, id, c.req.valid('json'), (current) => requireIfMatch(c, etagOf(current)));
    return c.json(toAccount(row), 200, { ETag: etagOf(row) });
  })
  .openapi(removeAccount, async (c) => {
    await deleteAccount(c.var.sync, c.var.principal, c.req.valid('param').id);
    return c.body(null, 204);
  })
  .openapi(syncAccount, async (c) => {
    await requestSync(c.var.principal, c.req.valid('param').id);
    return c.body(null, 202);
  })
  .openapi(putCredentials, async (c) => {
    const input = c.req.valid('json');
    const row = await replaceCredentials(c.var.sync, c.var.principal, c.req.valid('param').id, (account) => credentialsFor(account, input)).catch((error: unknown) => {
      throw connectProblem(error, input.provider);
    });
    return c.json(toAccount(row), 200, { ETag: etagOf(row) });
  })
  .openapi(reconnect, async (c) => {
    const { principal, oauth } = c.var;
    const account = await withTenant(principal.tenantId, (tx) => loadAccount(tx, principal, c.req.valid('param').id));
    const { returnTo } = c.req.valid('json');
    if (account.provider === 'microsoft') return c.json({ authorizationUrl: await startMicrosoftFlow(oauth, principal, returnTo, account.email) }, 200);
    if (account.provider !== 'google') throw new Unprocessable(`${account.provider} accounts do not reconnect through OAuth`, 'unsupported-provider');
    const authorizationUrl = await startGoogleFlow(oauth, principal, returnTo, account.email);
    return c.json({ authorizationUrl }, 200);
  });
