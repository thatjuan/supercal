/**
 * The Google provider in the daemon, against a mocked Google over a scratch database: the OAuth
 * flow (state tampering, foreign `returnTo`, reconnecting the same `sub`), `invalid_grant` on
 * refresh, a sync through the runner, the push webhook and channel renewal.
 */
import { calendarAccount, closeDb, connectDb, member, migrate, organization, pushLease, resource, sourceCalendar, syncTarget, user, type AccountId, type SourceCalendarId, type SyncTargetId, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { createGoogleAdapter, createGuardedFetch, GOOGLE_INVALID_GRANT_DETAIL, ProviderCredentials } from '@supercal/providers';
import { googleCredentials, mockGoogle, type MockRequest } from '@supercal/providers/test/google-mock';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { googleHooks } from '../src/hooks/google.ts';
import { createLogger } from '../src/log.ts';
import { credentialsContext } from '../src/sync/context.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { secretHash } from '../src/sync/push.ts';
import { claim, complete, type Job } from '../src/sync/scheduler.ts';
import { TEST_ORIGIN, testAuth, testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const userId = `user_alice_${crypto.randomUUID().slice(0, 8)}`;
const alice: Principal = { kind: 'user', userId, tenantId, role: 'member', via: 'session', isOperator: false };
let principal = alice;
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const CALENDAR_SCOPES = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (sub: string) => `${b64({ alg: 'none' })}.${b64({ iss: 'https://accounts.google.com', aud: 'client-id', sub, email: `${sub}@example.test` })}.sig`;

/** What the mocked Google answers; tests replace parts of it. */
const google = {
  sub: 'sub-1',
  scope: `openid email ${CALENDAR_SCOPES}`,
  refresh: (): Response => Response.json({ access_token: 'access-refreshed', expires_in: 3600 }),
  events: (_req: MockRequest): Response => Response.json({ items: [], nextSyncToken: 'token-1' }),
  onStop: async (_req: MockRequest) => {},
  watched: 0,
};

function handle(req: MockRequest): Response | Promise<Response> {
  if (req.path === '/token') {
    const form = new URLSearchParams(req.body);
    if (form.get('grant_type') === 'refresh_token') return google.refresh();
    if (form.get('code_verifier')?.length !== 43) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: google.scope, id_token: idToken(google.sub) });
  }
  if (req.path === '/calendar/v3/users/me/calendarList') return Response.json({ items: [{ id: 'work@example.test', summary: 'Work', backgroundColor: '#336699', timeZone: 'Europe/Paris' }] });
  if (req.path.endsWith('/watch')) {
    const { id } = JSON.parse(req.body) as { id: string };
    return Response.json({ id, resourceId: `res-${++google.watched}`, expiration: String(Date.now() + 7 * 86_400_000) });
  }
  if (req.path === '/calendar/v3/channels/stop') return google.onStop(req).then(() => new Response(null, { status: 204 }));
  if (req.path.endsWith('/events')) return google.events(req);
  return new Response(null, { status: 404 });
}

const mock = mockGoogle(handle);
const adapter = createGoogleAdapter({ ...mock.options, push: true });
const deps = createSyncDeps({ secrets: testSecrets, fetch: createGuardedFetch({ allow: [] }), log: createLogger({}, () => {}), adapters: { google: adapter }, pushBaseUrl: 'https://supercal.example.test' });
const handlers = syncHandlers(deps);
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let app: ReturnType<typeof createApi>;

async function startFlow(returnTo = '/accounts') {
  const res = await app.request('/api/v1/accounts/oauth/google/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnTo }) });
  return { status: res.status, url: res.status === 200 ? new URL(((await res.json()) as { authorizationUrl: string }).authorizationUrl) : null };
}

/** Starts a flow and follows Google's redirect back; returns the final redirect's URL. */
async function connectFlow(): Promise<URL> {
  const { url } = await startFlow();
  const res = await app.request(`/api/v1/oauth/google/callback?${new URLSearchParams({ code: 'the-code', state: url?.searchParams.get('state') ?? '' })}`);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location') ?? '');
}

const accountRow = async (id: string) => (await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, id as AccountId)))[0];

async function targetOf(kind: 'events' | 'discover' | 'push_renew', targetId: string): Promise<SyncTargetId> {
  const [row] = await unsafeDb().select({ id: syncTarget.id }).from(syncTarget).where(and(eq(syncTarget.kind, kind), eq(syncTarget.targetId, targetId)));
  if (!row) throw new Error(`no ${kind} target for ${targetId}`);
  return row.id;
}

/** Claims `id` now and runs it through its handler, as the scheduler does; returns the error, if any. */
async function runNow(id: SyncTargetId): Promise<unknown> {
  await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp()` }).where(eq(syncTarget.id, id));
  const [job]: Job[] = await claim('test', { leaseMs: 30_000, limit: 1, ids: [id] });
  if (!job) throw new Error(`could not claim ${id}`);
  try {
    await complete(job, { ok: true, ...(await handlers[job.kind](job, new AbortController().signal)) });
    return undefined;
  } catch (error) {
    await complete(job, { ok: false, error });
    return error;
  }
}

/** The calendar of the account connected by the first test. */
let account: { id: string; calendarId: SourceCalendarId };

describe.skipIf(!testDatabaseUrl)('Google provider', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('google');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    app = createApi(
      {
        auth: fixture.auth,
        secrets: testSecrets,
        bus: idleBus,
        adapters: { google: adapter },
        oauth: { stateSecret: 'state-secret', google: { clientId: 'client-id', clientSecret: 'client-secret', authorizeUrl: `${mock.url}/auth`, tokenUrl: `${mock.url}/token` } },
      },
      injectPrincipal,
    );
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'T', slug: tenantId, createdAt: now });
    await unsafeDb().insert(user).values({ id: userId, name: 'Alice', email: 'alice@example.com', updatedAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId, role: 'member', createdAt: now });
  });

  afterAll(async () => {
    mock.stop();
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('start asks for offline access with PKCE, and the callback connects the account by its sub', async () => {
    const { url } = await startFlow();
    expect(url?.origin).toBe(mock.url);
    const params = Object.fromEntries(url?.searchParams ?? []);
    expect(params).toMatchObject({
      client_id: 'client-id',
      redirect_uri: `${TEST_ORIGIN}/api/v1/oauth/google/callback`,
      scope: `openid email ${CALENDAR_SCOPES}`,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge_method: 'S256',
    });
    expect(params.code_verifier).toBeUndefined();

    const back = await connectFlow();
    expect(`${back.origin}${back.pathname}`).toBe(`${TEST_ORIGIN}/accounts`);
    const id = back.searchParams.get('accountId') ?? '';
    const row = await accountRow(id);
    expect(row).toMatchObject({ provider: 'google', providerSubject: 'sub-1', email: 'sub-1@example.test', status: 'active', ownerUserId: userId });
    expect(row?.credentials).not.toContain('refresh-1');
    const [calendar] = await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.accountId, id as AccountId));
    expect(calendar).toMatchObject({ providerCalendarId: 'work@example.test', color: '#336699', timezone: 'Europe/Paris' });
    if (!calendar) throw new Error('no calendar');
    account = { id, calendarId: calendar.id };
    // Push is on, so the calendar and the calendar list each get a watch to maintain.
    await targetOf('push_renew', calendar.id);
    await targetOf('push_renew', id);
  });

  test('a tampered or missing state is a 400; a foreign returnTo is a 400', async () => {
    const { url } = await startFlow();
    const state = url?.searchParams.get('state') ?? '';
    const [payload, signature] = state.split('.');
    const forged = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<string, unknown>;
    const tampered = `${b64({ ...forged, returnTo: 'https://evil.example/' })}.${signature}`;
    for (const bad of [tampered, '', 'garbage'])
      expect((await app.request(`/api/v1/oauth/google/callback?${new URLSearchParams({ code: 'c', state: bad })}`)).status).toBe(400);
    for (const returnTo of ['https://evil.example/accounts', '//evil.example/accounts', 'javascript:alert(1)']) expect((await startFlow(returnTo)).status).toBe(400);
  });

  test('a state is single-use and bound to the signed-in user', async () => {
    const { url } = await startFlow();
    const query = `?${new URLSearchParams({ code: 'c', state: url?.searchParams.get('state') ?? '' })}`;
    principal = { ...alice, userId: 'someone-else' };
    const mismatch = await app.request(`/api/v1/oauth/google/callback${query}`);
    principal = alice;
    expect(new URL(mismatch.headers.get('location') ?? '').searchParams.get('error')).toBe('session_mismatch');
    const used = await app.request(`/api/v1/oauth/google/callback${query}`);
    expect(new URL(used.headers.get('location') ?? '').searchParams.get('accountId')).toBe(account.id);
    const replay = await app.request(`/api/v1/oauth/google/callback${query}`);
    expect(new URL(replay.headers.get('location') ?? '').searchParams.get('error')).toBe('flow_expired');
  });

  test('missing calendar scopes send the browser back with an error', async () => {
    google.scope = 'openid email';
    const back = await connectFlow();
    google.scope = `openid email ${CALENDAR_SCOPES}`;
    expect(back.searchParams.get('error')).toBe('missing_scopes');
  });

  test('invalid_grant on refresh requires reauth, with the Testing-mode hint in status_detail', async () => {
    const expired = await testSecrets.encryptJson(ProviderCredentials, googleCredentials('sub-1', { expired: true }), credentialsContext({ id: account.id as AccountId, tenantId }));
    await unsafeDb().update(calendarAccount).set({ credentials: expired }).where(eq(calendarAccount.id, account.id as AccountId));
    google.refresh = () => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
    await runNow(await targetOf('discover', account.id));
    expect(await accountRow(account.id)).toMatchObject({ status: 'reauth_required', statusDetail: GOOGLE_INVALID_GRANT_DETAIL });
    google.refresh = () => Response.json({ access_token: 'access-refreshed', expires_in: 3600 });
  });

  test('reconnecting the same sub updates the account instead of duplicating it', async () => {
    const reconnect = await app.request(`/api/v1/accounts/${account.id}/reconnect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnTo: '/accounts' }) });
    const { authorizationUrl } = (await reconnect.json()) as { authorizationUrl: string };
    expect(new URL(authorizationUrl).searchParams.get('login_hint')).toBe('sub-1@example.test');

    const back = await connectFlow();
    expect(back.searchParams.get('accountId')).toBe(account.id);
    expect(await unsafeDb().select({ id: calendarAccount.id }).from(calendarAccount)).toHaveLength(1);
    const row = await accountRow(account.id);
    expect(row).toMatchObject({ status: 'active', statusDetail: null });
    const credentials = await testSecrets.decryptJson(ProviderCredentials, row?.credentials ?? '', credentialsContext({ id: account.id as AccountId, tenantId }));
    expect(credentials.value).toMatchObject({ provider: 'google', accessToken: 'access-1' });
    // The parked targets run again.
    const [events] = await unsafeDb().select({ due: sql<boolean>`${syncTarget.nextRunAt} <= clock_timestamp()` }).from(syncTarget).where(eq(syncTarget.id, await targetOf('events', account.calendarId)));
    expect(events?.due).toBe(true);
  });

  test('a sync stores the master and exceptions as one resource, and a cancelled master deletes it', async () => {
    const master = { id: 'm', etag: '"1"', iCalUID: 'm@example.test', summary: 'Standup', start: { dateTime: '2026-11-09T09:00:00+01:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-11-09T09:15:00+01:00', timeZone: 'Europe/Paris' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] };
    const cancelled = { id: 'm_20261110T080000Z', etag: '"2"', status: 'cancelled', recurringEventId: 'm', originalStartTime: { dateTime: '2026-11-10T09:00:00+01:00' } };
    google.events = (req) =>
      req.query.get('syncToken') ? Response.json({ items: [{ id: 'm', etag: '"3"', status: 'cancelled' }], nextSyncToken: 'token-2' }) : Response.json({ items: [master, cancelled], nextSyncToken: 'token-1' });
    const id = await targetOf('events', account.calendarId);
    expect(await runNow(id)).toBeUndefined();
    const [stored] = await unsafeDb().select().from(resource).where(eq(resource.sourceCalendarId, account.calendarId));
    expect(stored?.uid).toBe('m@example.test');
    expect(JSON.stringify(stored?.data?.master)).toContain('exdate');
    const [cursor] = await unsafeDb().select({ cursor: syncTarget.cursor }).from(syncTarget).where(eq(syncTarget.id, id));
    expect(cursor?.cursor).toEqual({ v: 1, syncToken: 'token-1' });

    expect(await runNow(id)).toBeUndefined();
    const [after] = await unsafeDb().select({ deleted: resource.deleted }).from(resource).where(eq(resource.sourceCalendarId, account.calendarId));
    expect(after?.deleted).toBe(true);
  });

  test.each(['master only', 'both with UID', 'both sparse'] as const)('deleting a series with a moved instance removes the resource: %s', async (scenario) => {
    const uid = `${scenario}@test`, masterId = `series-${scenario}`, instanceId = `${masterId}_instance`;
    const master = { id: masterId, etag: '1', iCalUID: uid, summary: 'Series', start: { dateTime: '2026-11-09T09:00:00Z' }, end: { dateTime: '2026-11-09T10:00:00Z' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] };
    const moved = { ...master, id: instanceId, recurringEventId: masterId, originalStartTime: { dateTime: '2026-11-10T09:00:00Z' }, start: { dateTime: '2026-11-10T11:00:00Z' }, end: { dateTime: '2026-11-10T12:00:00Z' } };
    const id = await targetOf('events', account.calendarId);
    google.events = () => Response.json({ items: [master, moved], nextSyncToken: 'before-delete' });
    expect(await runNow(id)).toBeUndefined();
    const where = and(eq(resource.sourceCalendarId, account.calendarId), eq(resource.uid, uid));
    expect((await unsafeDb().select().from(resource).where(where))[0]?.data?.overrides).toHaveLength(1);
    const head = { id: masterId, status: 'cancelled', ...(scenario === 'both with UID' && { iCalUID: uid }) };
    const instance = { id: instanceId, status: 'cancelled', recurringEventId: masterId, originalStartTime: moved.originalStartTime, ...(scenario === 'both with UID' && { iCalUID: uid }) };
    // Put the instance first, so page order cannot resurrect an already deleted master.
    google.events = () => Response.json({ items: scenario === 'master only' ? [head] : [instance, head], nextSyncToken: 'after-delete' });
    // handle() answers every events.get with 404, including sparse cancellation lookups.
    expect(await runNow(id)).toBeUndefined();
    expect((await unsafeDb().select().from(resource).where(where))[0]?.deleted).toBe(true);
  });

  test('an invitation to a moved instance with no master stays published', async () => {
    const uid = 'orphan-invitation@test';
    google.events = () => Response.json({ items: [{ id: 'invited-instance', iCalUID: uid, recurringEventId: 'unavailable-master', summary: 'Invitation',
      originalStartTime: { dateTime: '2026-11-09T09:00:00Z' }, start: { dateTime: '2026-11-09T11:00:00Z' }, end: { dateTime: '2026-11-09T12:00:00Z' } }], nextSyncToken: 'invitation' });
    expect(await runNow(await targetOf('events', account.calendarId))).toBeUndefined();
    const [stored] = await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, account.calendarId), eq(resource.uid, uid)));
    expect(stored?.deleted).toBe(false);
    expect(stored?.data?.master).toBeNull();
    expect(stored?.data?.overrides).toHaveLength(1);
  });

  test('the webhook wakes the channel’s target; a wrong token is a 404 and a sync message is ignored', async () => {
    const token = 'channel-secret';
    await unsafeDb().insert(pushLease).values({ providerChannelId: 'hook-1', tenantId, accountId: account.id as AccountId, target: 'calendar', targetId: account.calendarId, expiresAt: new Date(Date.now() + 86_400_000), secretHash: secretHash(token) });
    const id = await targetOf('events', account.calendarId);
    const generation = async () => (await unsafeDb().select({ g: syncTarget.wakeGeneration }).from(syncTarget).where(eq(syncTarget.id, id)))[0]?.g;
    const notify = (headers: Record<string, string>) => googleHooks.request('/hooks/google', { method: 'POST', headers: { 'x-goog-channel-id': 'hook-1', 'x-goog-resource-state': 'exists', ...headers } });

    const before = await generation();
    expect((await notify({ 'x-goog-channel-token': 'wrong' })).status).toBe(404);
    expect((await notify({ 'x-goog-channel-id': 'unknown', 'x-goog-channel-token': token })).status).toBe(404);
    expect((await notify({ 'x-goog-channel-token': token, 'x-goog-resource-state': 'sync' })).status).toBe(200);
    expect(await generation()).toBe(before);
    expect((await notify({ 'x-goog-channel-token': token })).status).toBe(200);
    expect(await generation()).toBe((before ?? 0) + 1);
    await unsafeDb().delete(pushLease);
  });

  test('a channel near expiry is replaced, and the old one is stopped only after the new one is stored', async () => {
    const day = 86_400_000;
    await unsafeDb()
      .insert(pushLease)
      .values({ providerChannelId: 'old', providerResourceId: 'res-old', tenantId, accountId: account.id as AccountId, target: 'calendar', targetId: account.calendarId, createdAt: new Date(Date.now() - 6 * day), expiresAt: new Date(Date.now() + day), secretHash: 'x' });
    const leasesWhenStopped: string[][] = [];
    google.onStop = async () => void leasesWhenStopped.push((await unsafeDb().select({ id: pushLease.providerChannelId }).from(pushLease)).map((l) => l.id).sort());

    expect(await runNow(await targetOf('push_renew', account.calendarId))).toBeUndefined();
    const watch = mock.requests.findLast((r) => r.path.endsWith('/events/watch'));
    const body = JSON.parse(watch?.body ?? '{}') as { id: string; address: string; token: string; type: string };
    expect(watch?.path).toBe('/calendar/v3/calendars/work%40example.test/events/watch');
    expect(body).toMatchObject({ type: 'web_hook', address: 'https://supercal.example.test/hooks/google' });
    const stop = mock.requests.findLast((r) => r.path === '/calendar/v3/channels/stop');
    expect(JSON.parse(stop?.body ?? '{}')).toEqual({ id: 'old', resourceId: 'res-old' });
    expect(leasesWhenStopped).toEqual([[body.id, 'old'].sort()]);

    const leases = await unsafeDb().select().from(pushLease);
    expect(leases.map((l) => [l.providerChannelId, l.secretHash])).toEqual([[body.id, secretHash(body.token)]]);
    // The next renewal is due at 80% of the new channel's lifetime.
    const [target] = await unsafeDb().select({ dueInDays: sql<number>`extract(epoch from ${syncTarget.nextRunAt} - clock_timestamp())::float8 / 86400` }).from(syncTarget).where(eq(syncTarget.id, await targetOf('push_renew', account.calendarId)));
    expect(target?.dueInDays).toBeCloseTo(5.6, 1);
  });
});
