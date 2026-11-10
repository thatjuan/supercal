/**
 * The Microsoft provider in the daemon, against a mocked Graph over a scratch database: the OAuth
 * flow and reconnect by `${tid}:${oid}`, reconciliation through the runner (touches, the sweep,
 * cancellations resolved through `graph_occurrence`, incomplete resources), the mailbox
 * subscription and the change and lifecycle webhooks.
 */
import { calendarAccount, davLogin, sourceObject, closeDb, connectDb, graphOccurrence, member, migrate, organization, pushLease, resource, sourceCalendar, syncTarget, user, type AccountId, type SourceCalendarId, type SyncTargetId, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { createGuardedFetch, createMicrosoftAdapter } from '@supercal/providers';
import { mockGraph, singleEvent, weeklySeries } from '@supercal/providers/test/graph-mock';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { createDav } from '../src/dav/index.ts';
import { verifyGraphUidWithTsdav } from './dav/clients/microsoft_tsdav.ts';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { microsoftHooks } from '../src/hooks/microsoft.ts';
import { createLogger } from '../src/log.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { secretHash } from '../src/sync/push.ts';
import { claim, complete, type Job } from '../src/sync/scheduler.ts';
import { TEST_ORIGIN, testAuth, testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const userId = `user_ann_${crypto.randomUUID().slice(0, 8)}`;
const principal: Principal = { kind: 'user', userId, tenantId, role: 'member', via: 'session', isOperator: false };
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ iss: 'https://login.microsoftonline.com/tid-1/v2.0', aud: 'client-id', tid: 'tid-1', oid: 'oid-1', preferred_username: 'ann@example.test' })}.sig`;

let grantedScope = 'Calendars.Read';
const graph = mockGraph();
graph.calendars.push({ id: 'cal-a', name: 'Calendar', hexColor: '#336699', canEdit: true }, { id: 'cal-b', name: 'Team', color: 'lightTeal', canEdit: false });
graph.state.token = (form) =>
  form.get('grant_type') === 'authorization_code'
    ? Response.json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: `openid email https://graph.microsoft.com/${grantedScope} https://graph.microsoft.com/User.Read`, id_token: idToken })
    : Response.json({ access_token: 'access-2', expires_in: 3600, refresh_token: 'refresh-2' });

const adapter = createMicrosoftAdapter({ ...graph.options, push: true });
const deps = createSyncDeps({ secrets: testSecrets, fetch: createGuardedFetch({ allow: [] }), log: createLogger({}, () => {}), adapters: { microsoft: adapter }, pushBaseUrl: 'https://supercal.example.test' });
const handlers = syncHandlers(deps);
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let app: ReturnType<typeof createApi>;

const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Starts a flow and follows Microsoft's redirect back; returns the start URL and the final redirect. */
async function connectFlow(): Promise<{ start: URL; back: URL }> {
  const { authorizationUrl } = (await (await post('/api/v1/accounts/oauth/microsoft/start', { returnTo: '/accounts' })).json()) as { authorizationUrl: string };
  const start = new URL(authorizationUrl);
  const res = await app.request(`/api/v1/oauth/microsoft/callback?${new URLSearchParams({ code: 'the-code', state: start.searchParams.get('state') ?? '' })}`);
  expect(res.status).toBe(302);
  return { start, back: new URL(res.headers.get('location') ?? '') };
}

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

const resourceOf = async (calendarId: SourceCalendarId, uid: string) => (await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, calendarId), eq(resource.uid, uid))))[0];
const generations = async (ids: SyncTargetId[]) =>
  Promise.all(ids.map(async (id) => (await unsafeDb().select({ g: syncTarget.wakeGeneration }).from(syncTarget).where(eq(syncTarget.id, id)))[0]?.g));

/** The one mailbox subscription the mock holds. */
const theSubscription = () => z.object({ id: z.string(), clientState: z.string(), notificationUrl: z.string() }).parse([...graph.subscriptions.values()][0]);

let account: { id: AccountId; calendarA: SourceCalendarId; calendarB: SourceCalendarId };

describe.skipIf(!testDatabaseUrl)('Microsoft provider', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('microsoft');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    app = createApi(
      {
        auth: fixture.auth,
        secrets: testSecrets,
        bus: idleBus,
        adapters: { microsoft: adapter },
        oauth: { stateSecret: 'state-secret', microsoft: { clientId: 'client-id', clientSecret: 'client-secret', authorizeUrl: `${graph.url}/authorize`, tokenUrl: `${graph.url}/token` } },
      },
      injectPrincipal,
    );
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'T', slug: tenantId, createdAt: now });
    await unsafeDb().insert(user).values({ id: userId, name: 'Ann', email: 'ann@example.com', updatedAt: now });
    await unsafeDb().insert(davLogin).values({ tenantId, userId, name: 'Microsoft device', username: 'microsoft-writer-abcdefgh', passwordHash: await Bun.password.hash('device-password', { algorithm: 'argon2id' }) });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId, role: 'member', createdAt: now });
  });

  afterAll(async () => {
    graph.stop();
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('the callback connects the account as tid:oid with both calendars and one mailbox subscription target', async () => {
    const { start, back } = await connectFlow();
    expect(Object.fromEntries(start.searchParams)).toMatchObject({
      client_id: 'client-id',
      redirect_uri: `${TEST_ORIGIN}/api/v1/oauth/microsoft/callback`,
      response_type: 'code',
      scope: 'openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    const id = back.searchParams.get('accountId') as AccountId;
    const [row] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, id));
    expect(row).toMatchObject({ provider: 'microsoft', providerSubject: 'tid-1:oid-1', email: 'ann@example.test', status: 'active' });
    const calendars = await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.accountId, id));
    const byProvider = new Map(calendars.map((c) => [c.providerCalendarId, c]));
    expect(byProvider.get('cal-b')?.color).toBe('#26a69a');
    const calendarA = byProvider.get('cal-a')?.id;
    const calendarB = byProvider.get('cal-b')?.id;
    if (!calendarA || !calendarB) throw new Error('calendars missing');
    account = { id, calendarA, calendarB };
    await targetOf('push_renew', id);
    // The mailbox subscription covers every calendar: none of their own.
    expect(await unsafeDb().select().from(syncTarget).where(and(eq(syncTarget.kind, 'push_renew'), eq(syncTarget.targetId, calendarA)))).toEqual([]);
  });

  test('reconnecting the same identity updates the account, preselecting its address', async () => {
    const res = await post(`/api/v1/accounts/${account.id}/reconnect`, { returnTo: '/accounts' });
    expect(new URL(((await res.json()) as { authorizationUrl: string }).authorizationUrl).searchParams.get('login_hint')).toBe('ann@example.test');
    const { back } = await connectFlow();
    expect(back.searchParams.get('accountId')).toBe(account.id);
    expect(await unsafeDb().select({ id: calendarAccount.id }).from(calendarAccount)).toHaveLength(1);
  });

  test('reconciliation: unchanged items are not fetched, removed ones are swept, and an indexed cancellation becomes an EXDATE', async () => {
    const exception = { id: 'ex-1', changeKey: 'xk1', type: 'exception', seriesMasterId: 'series', originalStart: '2026-11-02T17:00:00Z', start: { dateTime: '2026-11-02T19:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-02T20:00:00', timeZone: 'UTC' }, subject: 'Moved' };
    graph.put('cal-a', singleEvent('one', 'k1'));
    graph.put('cal-a', singleEvent('two', 'k1'));
    graph.put('cal-a', weeklySeries('series', 'sk1', { exceptionOccurrences: [exception] }));
    const id = await targetOf('events', account.calendarA);
    expect(await runNow(id)).toBeUndefined();
    expect((await resourceOf(account.calendarA, 'series@example.test'))?.data?.overrides).toHaveLength(1);
    expect(await unsafeDb().select({ id: graphOccurrence.occurrenceId }).from(graphOccurrence)).toEqual([{ id: 'ex-1' }]);

    // The exception is cancelled: Graph now names only its id. `one` is deleted; `two` is unchanged.
    graph.remove('cal-a', 'one');
    graph.put('cal-a', weeklySeries('series', 'sk2', { cancelledOccurrences: ['ex-1'] }));
    graph.requests.length = 0;
    expect(await runNow(id)).toBeUndefined();
    expect(graph.fetched()).toEqual(['series']);
    expect(graph.requests.some((r) => r.path.endsWith('/instances'))).toBe(false);
    expect((await resourceOf(account.calendarA, 'one@example.test'))?.deleted).toBe(true);
    expect((await resourceOf(account.calendarA, 'two@example.test'))?.deleted).toBe(false);
    const series = await resourceOf(account.calendarA, 'series@example.test');
    expect(series?.completeness).toBe('complete');
    expect(series?.data?.overrides).toEqual([]);
    expect(JSON.stringify(series?.data?.master)).toContain('"exdate",{"tzid":"America/Los_Angeles"},"date-time","2026-11-02T09:00:00"');
  });

  test('a cancellation no listing can resolve still publishes the master, incomplete', async () => {
    graph.put('cal-b', weeklySeries('cold', 'ck1', { cancelledOccurrences: ['never-seen'] }));
    expect(await runNow(await targetOf('events', account.calendarB))).toBeUndefined();
    const cold = await resourceOf(account.calendarB, 'cold@example.test');
    expect(cold?.data?.master).not.toBeNull();
    expect(cold).toMatchObject({ completeness: 'incomplete', completenessReason: expect.stringContaining('graph-cancelled-occurrence-unresolved') });
    expect(graph.requests.filter((r) => r.path === '/v1.0/me/events/cold/instances')).toHaveLength(1);
  });

  test('a custom zone or an unsupported recurrence keeps the last good data, marked incomplete', async () => {
    const id = await targetOf('events', account.calendarB);
    const good = weeklySeries('bad', 'bk1');
    graph.put('cal-b', good);
    expect(await runNow(id)).toBeUndefined();
    const before = await resourceOf(account.calendarB, 'bad@example.test');
    expect(before?.completeness).toBe('complete');

    graph.put('cal-b', { ...good, changeKey: 'bk2', originalStartTimeZone: 'tzone://Microsoft/Custom', recurrence: null });
    expect(await runNow(id)).toBeUndefined();
    const custom = await resourceOf(account.calendarB, 'bad@example.test');
    expect(custom?.data).toEqual(before?.data ?? null);
    expect(custom).toMatchObject({ completeness: 'incomplete', completenessReason: 'Unknown time zone: tzone://Microsoft/Custom' });

    graph.put('cal-b', { ...good, changeKey: 'bk3' });
    expect(await runNow(id)).toBeUndefined();
    graph.put('cal-b', { ...good, changeKey: 'bk4', recurrence: { ...good.recurrence, range: { type: 'noEnd', startDate: '2026-10-27' } } });
    expect(await runNow(id)).toBeUndefined();
    const unsupported = await resourceOf(account.calendarB, 'bad@example.test');
    expect(unsupported?.data).toEqual(before?.data ?? null);
    expect(unsupported?.completenessReason).toStartWith('graph-recurrence-unsupported');
  });

  test('push_renew subscribes the mailbox once, storing only the clientState hash', async () => {
    expect(await runNow(await targetOf('push_renew', account.id))).toBeUndefined();
    const subscription = theSubscription();
    expect(subscription.notificationUrl).toBe('https://supercal.example.test/hooks/microsoft');
    const leases = await unsafeDb().select().from(pushLease);
    expect(leases.map((l) => [l.providerChannelId, l.target, l.targetId, l.secretHash])).toEqual([[subscription.id, 'account', account.id, secretHash(subscription.clientState)]]);
  });

  test('the validation handshake is echoed as plain text on both endpoints', async () => {
    for (const path of ['/hooks/microsoft', '/hooks/microsoft/lifecycle']) {
      const res = await microsoftHooks.request(`${path}?validationToken=${encodeURIComponent('Validation: Testing client application reachability for subscription Request-Id: 1')}`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toStartWith('text/plain');
      expect(await res.text()).toBe('Validation: Testing client application reachability for subscription Request-Id: 1');
    }
  });

  test('both hook routes reject oversized bodies with Content-Length and chunked transfer', async () => {
    for (const path of ['/hooks/microsoft', '/hooks/microsoft/lifecycle']) {
      for (const chunked of [false, true]) {
        const body = new TextEncoder().encode(JSON.stringify({ value: [], padding: 'x'.repeat(256 * 1024) }));
        const res = await microsoftHooks.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(body.byteLength) }) },
          body: chunked ? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body.subarray(0, 128 * 1024)); controller.enqueue(body.subarray(128 * 1024)); controller.close(); } }) : body,
        });
        expect(res.status).toBe(413);
      }
    }
  });

  test('both hook routes reject more than 1,000 notifications', async () => {
    for (const path of ['/hooks/microsoft', '/hooks/microsoft/lifecycle']) {
      const res = await microsoftHooks.request(path, { method: 'POST', body: JSON.stringify({ value: Array.from({ length: 1001 }, () => ({ subscriptionId: 'unknown', clientState: 'wrong' })) }) });
      expect(res.status).toBe(400);
    }
  });

  test('a notification wakes every calendar of the account; a wrong clientState is ignored', async () => {
    const subscription = theSubscription();
    const ids = [await targetOf('events', account.calendarA), await targetOf('events', account.calendarB)];
    const notify = (clientState: string) =>
      microsoftHooks.request('/hooks/microsoft', { method: 'POST', body: JSON.stringify({ value: [{ subscriptionId: subscription.id, clientState, changeType: 'updated', resource: 'Users/x/Events/y' }] }) });
    const before = await generations(ids);
    expect((await notify('wrong')).status).toBe(202);
    expect(await generations(ids)).toEqual(before);
    expect((await notify(subscription.clientState)).status).toBe(202);
    expect(await generations(ids)).toEqual(before.map((g) => (g ?? 0) + 1));
  });

  test('lifecycle: missed wakes every target, reauthorizationRequired renews now, subscriptionRemoved recreates', async () => {
    const subscription = theSubscription();
    const lifecycle = (lifecycleEvent: string, subscriptionId = subscription.id) =>
      microsoftHooks.request('/hooks/microsoft/lifecycle', { method: 'POST', body: JSON.stringify({ value: [{ subscriptionId, clientState: subscription.clientState, lifecycleEvent }] }) });
    const all = await unsafeDb().select({ id: syncTarget.id }).from(syncTarget);
    const before = await generations(all.map((t) => t.id));
    expect((await lifecycle('missed')).status).toBe(202);
    expect(await generations(all.map((t) => t.id))).toEqual(before.map((g) => (g ?? 0) + 1));

    const renew = await targetOf('push_renew', account.id);
    expect((await lifecycle('reauthorizationRequired')).status).toBe(202);
    expect(await runNow(renew)).toBeUndefined();
    expect(graph.requests.findLast((r) => r.path.startsWith('/v1.0/subscriptions'))?.method).toBe('PATCH');
    const [renewed] = await unsafeDb().select().from(pushLease);
    expect(renewed?.providerChannelId).toBe(subscription.id);
    expect((renewed?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(9_000 * 60_000);

    expect((await lifecycle('subscriptionRemoved')).status).toBe(202);
    expect(await unsafeDb().select().from(pushLease)).toEqual([]);
    expect(await runNow(renew)).toBeUndefined();
    const [recreated] = await unsafeDb().select().from(pushLease);
    expect(recreated?.providerChannelId).not.toBe(subscription.id);
  });
  test('device creates retain href across Graph UID assignment, occurrence edits/cancellations and series deletion', async () => {
    const dav = createDav({ ...deps, bus: idleBus });
    const authorization = `Basic ${btoa('microsoft-writer-abcdefgh:device-password')}`;
    const request = (calendarId: string, method: string, name = '', body?: string, headers: Record<string, string> = {}) => dav.request(`/dav/microsoft-writer-abcdefgh/cal/${calendarId}/${name}`, { method, headers: { authorization, 'content-type': 'text/calendar', ...headers }, ...(body !== undefined && { body }) });
    const ics = (uid: string, override = '', rule = 'FREQ=DAILY;COUNT=5') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z', 'DTSTART:20261109T090000Z', 'DURATION:PT1H', 'SUMMARY:Device series', `RRULE:${rule}`, 'END:VEVENT', override, 'END:VCALENDAR', ''].filter(Boolean).join('\r\n') + '\r\n';
    const active = async () => expect((await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id)))[0]?.status).toBe('active');
    expect((await request(account.calendarA, 'PUT', 'device.ics', ics('client@test'))).status).toBe(403);
    await active();
    const allow = () => post(`/api/v1/accounts/${account.id}/allow-editing`, { returnTo: '/accounts' });
    const callback = (url: URL) => app.request(`/api/v1/oauth/microsoft/callback?${new URLSearchParams({ code: 'code', state: url.searchParams.get('state') ?? '' })}`);
    const consent = await allow();
    expect(consent.status).toBe(409);
    const url = new URL(((await consent.json()) as { authorizationUrl: string }).authorizationUrl);
    expect(url.searchParams.get('scope')).toContain('Calendars.ReadWrite');
    expect(url.searchParams.get('login_hint')).toBe('ann@example.test');
    expect(new URL((await callback(url)).headers.get('location')!).searchParams.get('error')).toBe('consent_declined');
    await active();
    const tokenResponse = graph.state.token;
    graph.state.token = (form) => form.get('grant_type') === 'authorization_code'
      ? Response.json({ access_token: 'other', expires_in: 3600, refresh_token: 'other', scope: 'Calendars.ReadWrite', id_token: `${b64({ alg: 'none' })}.${b64({ iss: 'https://login.microsoftonline.com/tid-1/v2.0', aud: 'client-id', tid: 'tid-1', oid: 'another-account', preferred_username: 'other@example.test' })}.sig` })
      : tokenResponse(form);
    const wrongAccount = new URL(((await (await allow()).json()) as { authorizationUrl: string }).authorizationUrl);
    expect(new URL((await callback(wrongAccount)).headers.get('location')!).searchParams.get('error')).toBe('account_mismatch');
    graph.state.token = tokenResponse;
    grantedScope = 'Calendars.ReadWrite';
    const retry = new URL(((await (await allow()).json()) as { authorizationUrl: string }).authorizationUrl);
    const discover = await targetOf('discover', account.id);
    await unsafeDb().update(syncTarget).set({ nextRunAt: sql`now() + interval '1 day'` }).where(eq(syncTarget.id, discover));
    expect(new URL((await callback(retry)).headers.get('location')!).searchParams.get('accountId')).toBe(account.id);
    expect((await unsafeDb().select().from(syncTarget).where(eq(syncTarget.id, discover)))[0]!.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await runNow(discover)).toBeUndefined();
    expect((await allow()).status).toBe(204);
    expect((await request(account.calendarB, 'PUT', 'readonly.ics', ics('client@test'))).status).toBe(403);
    await active();
    const before = graph.requests.length;
    const invalid = await request(account.calendarA, 'PUT', 'invalid.ics', ics('bad@test', '', 'FREQ=HOURLY'));
    expect(invalid.status).toBe(403);
    expect(await invalid.text()).toContain('valid-calendar-data');
    expect(graph.requests).toHaveLength(before);
    expect((await request(account.calendarA, 'PUT', 'device.ics', ics('client@test'), { 'If-None-Match': '*' })).status).toBe(201);
    const first = await request(account.calendarA, 'GET', 'device.ics');
    const text = await first.text();
    const uid = /UID:([^\r\n]+)/.exec(text)?.[1];
    expect(uid).toEndWith('@outlook.test');
    if (!uid) throw new Error('missing Graph UID');
    expect(uid).not.toBe('client@test');
    expect(first.headers.get('etag')).toBeTruthy();
    const [master] = await unsafeDb().select().from(sourceObject).where(and(eq(sourceObject.sourceCalendarId, account.calendarA), eq(sourceObject.groupUid, uid)));
    graph.instances.set(master!.providerObjectId, [{ id: 'device-occurrence', originalStart: '2026-11-10T09:00:00Z' }]);
    const override = (cancel = false) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261101T000000Z', 'RECURRENCE-ID:20261110T090000Z', 'DTSTART:20261110T110000Z', 'DURATION:PT1H', 'SUMMARY:Changed occurrence', ...(cancel ? ['STATUS:CANCELLED'] : []), 'END:VEVENT'].join('\r\n');
    expect((await request(account.calendarA, 'PUT', 'device.ics', ics(uid, override()), { 'If-Match': first.headers.get('etag')! })).status).toBe(204);
    const edited = await request(account.calendarA, 'GET', 'device.ics');
    expect(await edited.text()).toContain('SUMMARY:Changed occurrence');
    expect((await unsafeDb().select().from(graphOccurrence).where(eq(graphOccurrence.sourceCalendarId, account.calendarA))).some((row) => row.occurrenceId === 'device-occurrence')).toBe(true);
    expect((await request(account.calendarA, 'PUT', 'device.ics', ics(uid, override(true)), { 'If-Match': edited.headers.get('etag')! })).status).toBe(204);
    const cancelled = await request(account.calendarA, 'GET', 'device.ics');
    expect(await cancelled.text()).toContain('EXDATE:20261110T090000Z');
    expect((await request(account.calendarA, 'DELETE', 'device.ics', undefined, { 'If-Match': cancelled.headers.get('etag')! })).status).toBe(204);
    expect((await request(account.calendarA, 'GET', 'device.ics')).status).toBe(404);
    graph.state.intercept = (r) => r.method === 'POST' && r.path.endsWith('/events') ? Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 }) : undefined;
    expect((await request(account.calendarA, 'PUT', 'denied.ics', ics('denied@test'))).status).toBe(403);
    await active();
    graph.state.intercept = () => undefined;
    const server = Bun.serve({ port: 0, fetch: (req) => dav.fetch(req) });
    try { await verifyGraphUidWithTsdav(`http://localhost:${server.port}/`, account.calendarA); }
    finally { server.stop(true); }
  });

});
