/** Provider write-through through real device DAV authentication, tenant transactions and sync. */
import { calendarAccount, closeDb, connectDb, davObjectName, migrate, resource, sourceCalendar, sourceObject, syncTarget, withTenant } from '@supercal/db';
import { scratchDatabase, sqlState, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { AuthFailedError, createGuardedFetch, ProviderConflictError, ProviderPartialWriteError, ProviderThrottledError, ProviderUnavailableError, ProviderWriteRejectedError } from '@supercal/providers';
import { createFakeAdapter, fakeEvent } from '@supercal/providers/test/fake';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import type { Principal } from '../../src/auth/principal.ts';
import { idleBus } from '../../src/bus.ts';
import { createDav } from '../../src/dav/index.ts';
import { createLogger } from '../../src/log.ts';
import { connectAccount } from '../../src/sync/accounts.ts';
import { createSyncDeps, syncHandlers } from '../../src/sync/index.ts';
import { claim, complete } from '../../src/sync/scheduler.ts';
import { testSecrets } from '../auth-fixture.ts';
import { DEVICE, seedHosted } from './hosted-fixture.ts';

const principal: Principal = { kind: 'user', via: 'davLogin', userId: DEVICE.userId, tenantId: DEVICE.tenantId, role: 'member', isOperator: false };
const authorization = `Basic ${btoa(`${DEVICE.username}:${DEVICE.password}`)}`;
const body = (uid: string, summary = uid) => fakeEvent(uid, { summary }).payload;
const query = '<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><cal:calendar-data/></d:prop><cal:filter><cal:comp-filter name="VCALENDAR"/></cal:filter></cal:calendar-query>';
const sync = '<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>';
let scratch: Awaited<ReturnType<typeof scratchDatabase>>;

/** A fresh writable imported calendar, with a fake provider that uses conditional stored ETags. */
async function setup({ writable = true, snapshot = false } = {}) {
  const fake = createFakeAdapter({ provider: 'caldav', mode: snapshot ? 'snapshot' : 'delta' });
  fake.calendar('work', { capabilities: { incremental: 'snapshot', push: false, write: writable } });
  const deps = createSyncDeps({ adapters: { caldav: fake.adapter }, secrets: testSecrets, fetch: createGuardedFetch({ allow: [] }), log: createLogger({}, () => {}) });
  const { account, calendars } = await connectAccount(deps, principal, { displayName: 'Writeback', credentials: { provider: 'caldav', serverUrl: 'https://dav.test/', username: 'u', password: 'p' } });
  const calendar = calendars[0]!;
  const path = `/dav/${DEVICE.username}/cal/${calendar.id}/`;
  const dav = createDav({ ...deps, bus: idleBus });
  async function request(method: string, name = '', ics?: string, headers: Record<string, string> = {}) {
    return dav.request(path + name, { method, headers: { authorization, 'content-type': 'text/calendar', ...headers }, ...(ics !== undefined && { body: ics }) });
  }
  async function target() {
    const [row] = await unsafeDb().select().from(syncTarget).where(and(eq(syncTarget.kind, 'events'), eq(syncTarget.targetId, calendar.id)));
    if (!row) throw new Error('No target');
    return row;
  }
  return { fake, deps, account, calendar, path, request, target };
}

/** A gate lets a test hold a sync after its snapshot was fetched. */
function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe.skipIf(!testDatabaseUrl)('imported DAV write-through', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('dav_writeback');
    await migrate(scratch.url);
    connectDb(scratch.url);
    await seedHosted();
  });
  afterAll(async () => { await closeDb(); await scratch?.drop(); });

  test('client names, conditional edits, provider conflicts and deletion all run outside transactions', async () => {
    const { fake, deps, calendar, path, request, target } = await setup();
    let calls = 0;
    // Any attempt to take a sync slot would fail the write.
    deps.accountSlot = async () => { throw new Error('Writes must not acquire a sync slot'); };
    fake.hooks.beforeWrite = async () => {
      const [row] = await unsafeDb().execute<{ open: number }>(sql`select count(*)::int as open from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null`);
      expect(row?.open).toBe(0);
      calls++;
    };
    const created = await request('PUT', 'client%20chosen.ics', body('first'), { 'If-None-Match': '*' });
    expect(created.status).toBe(201);
    expect(created.headers.has('etag')).toBe(false);
    const get = await request('GET', 'client%20chosen.ics');
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('UID:first');
    const multiget = `<cal:calendar-multiget xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:prop><cal:calendar-data/></d:prop><d:href>${path}client%20chosen.ics</d:href></cal:calendar-multiget>`;
    expect(await (await request('REPORT', '', multiget)).text()).toContain('UID:first');
    const privileges = await (await request('PROPFIND')).text();
    expect(privileges).toContain('<d:write-content/>');
    for (const method of ['DELETE', 'PROPPATCH', 'MKCALENDAR']) {
      const response = await request(method);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('need-privileges');
    }
    const etag = get.headers.get('etag')!;
    expect((await request('PUT', 'client%20chosen.ics', body('first'), { 'If-None-Match': '*' })).status).toBe(412);
    const duplicate = await request('PUT', 'elsewhere.ics', body('first'));
    expect(duplicate.status).toBe(403);
    expect(await duplicate.text()).toContain('client%20chosen.ics');
    expect((await request('PUT', 'client%20chosen.ics', body('different'))).status).toBe(403);
    const updated = await request('PUT', 'client%20chosen.ics', body('first', 'Edited'), { 'If-Match': etag });
    expect(updated.status).toBe(204);
    expect(updated.headers.has('etag')).toBe(false);
    expect((await request('PUT', 'client%20chosen.ics', body('first'), { 'If-Match': etag })).status).toBe(412);
    const latest = await request('GET', 'client%20chosen.ics');
    const provider = fake.calendar('work');
    const upstreamId = [...provider.objects.keys()][0]!;
    provider.put(upstreamId, fakeEvent('first', { summary: 'Upstream changed' }));
    expect((await request('PUT', 'client%20chosen.ics', body('first'), { 'If-Match': latest.headers.get('etag')! })).status).toBe(412);
    // Restore the stored upstream ETag to exercise a successful delete after the conflict.
    const [stored] = await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
    provider.put(upstreamId, { groupUid: 'first', payload: stored!.payload, etag: stored!.etag! });
    const beforeDelete = await request('REPORT', '', sync);
    const token = /<d:sync-token>([^<]+)/.exec(await beforeDelete.text())?.[1]!;
    expect((await request('DELETE', 'client%20chosen.ics', undefined, { 'If-Match': latest.headers.get('etag')! })).status).toBe(204);
    expect((await request('GET', 'client%20chosen.ics')).status).toBe(404);
    expect(provider.objects.size).toBe(0);
    expect(await unsafeDb().select().from(davObjectName).where(eq(davObjectName.sourceCalendarId, calendar.id))).toEqual([]);
    const tombstone = await request('REPORT', '', sync.replace('<d:sync-token/>', `<d:sync-token>${token}</d:sync-token>`));
    expect(await tombstone.text()).toContain(`<d:href>${path}client%20chosen.ics</d:href><d:status>HTTP/1.1 404`);
    expect(calls).toBe(4);
    expect((await target()).wakeGeneration).toBeGreaterThan(0);
  });

  test('a partial provider result is published before its cause returns to the device', async () => {
    const { fake, account, calendar, request } = await setup();
    const writes = fake.adapter.writes!;
    const put = writes.put;
    writes.put = async (...args) => {
      const partial = await put(...args);
      throw new ProviderPartialWriteError(partial, new ProviderConflictError('Later operation conflicted'));
    };
    expect((await request('PUT', 'partial.ics', body('partial-accepted'))).status).toBe(412);
    const get = await request('GET', 'partial.ics');
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('UID:partial-accepted');
    expect((await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id)))[0]?.dirty).toBe(false);
    expect((await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id)))[0]?.status).toBe('active');
  });

  test('a snapshot started before create cannot sweep it or publish an unrelated partial group', async () => {
    const { fake, deps, calendar, request, target } = await setup({ snapshot: true });
    fake.calendar('work').put('partial.ics', fakeEvent('partial'));
    const paused = gate();
    const release = gate();
    fake.hooks.beforeItem = async (_calendar, item) => {
      if (item.kind === 'end') { paused.open(); await release.promise; }
    };
    const [job] = await claim('writeback-race', { leaseMs: 30_000, limit: 1, ids: [(await target()).id] });
    if (!job) throw new Error('No claimed job');
    const running = syncHandlers(deps).events(job, new AbortController().signal);
    try {
      await paused.promise;
      expect((await request('PUT', 'created.ics', body('created'))).status).toBe(201);
      const partial = await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, 'partial')));
      expect(partial).toEqual([]);
      const [created] = await unsafeDb().select().from(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.groupUid, 'created')));
      expect(created?.seenGeneration).toBe(job.version);
    } finally { release.open(); }
    const outcome = await running;
    await complete(job, { ok: true, nextRunInMs: outcome.nextRunInMs });
    expect((await request('GET', 'created.ics')).status).toBe(200);
    expect((await target()).nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await (await request('REPORT', '', query)).text()).toContain('UID:partial');
  });

  test('a previously synced UID uses its computed href and keeps a client name through later sync edits', async () => {
    const { fake, deps, calendar, request, target } = await setup();
    const handlers = syncHandlers(deps);
    async function syncOnce() {
      const targetId = (await target()).id;
      await unsafeDb().update(syncTarget).set({ nextRunAt: sql`now()` }).where(eq(syncTarget.id, targetId));
      const [job] = await claim('sync-existing', { leaseMs: 30_000, limit: 1, ids: [targetId] });
      if (!job) throw new Error('No claimed job');
      const outcome = await handlers.events(job, new AbortController().signal);
      await complete(job, { ok: true, nextRunInMs: outcome.nextRunInMs });
    }
    fake.calendar('work').put('original.ics', fakeEvent('original'));
    await syncOnce();
    const listing = await (await request('PROPFIND', '', undefined, { Depth: '1' })).text();
    const href = /<d:href>[^<]*\/([^/<]+\.ics)<\/d:href>/.exec(listing)?.[1];
    if (!href) throw new Error('No computed object href');
    const get = await request('GET', href);
    expect((await request('PUT', href, body('original', 'Device edited'), { 'If-Match': get.headers.get('etag')! })).status).toBe(204);
    expect(fake.calendar('work').objects.get('original.ics')?.payload).toContain('SUMMARY:Device edited');
    expect(await unsafeDb().select().from(davObjectName).where(eq(davObjectName.sourceCalendarId, calendar.id))).toEqual([]);
    expect((await request('PUT', 'kept.ics', body('kept'))).status).toBe(201);
    const upstreamId = [...fake.calendar('work').objects].find(([, object]) => object.groupUid === 'kept')?.[0]!;
    fake.calendar('work').put(upstreamId, fakeEvent('kept', { summary: 'Provider edited' }));
    await syncOnce();
    expect(await (await request('GET', 'kept.ics')).text()).toContain('SUMMARY:Provider edited');
    const [stored] = await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, 'kept')));
    expect(stored?.objectName).toBe('kept.ics');
  });

  test('unpublished sync edits refuse PUT and DELETE until the client refetches the published version', async () => {
    const { fake, deps, calendar, request, target } = await setup();
    expect((await request('PUT', 'pending.ics', body('pending', 'Before sync'))).status).toBe(201);
    const before = await request('GET', 'pending.ics');
    const oldEtag = before.headers.get('etag')!;
    const provider = fake.calendar('work');
    const upstreamId = [...provider.objects.keys()][0]!;
    provider.put(upstreamId, fakeEvent('pending', { summary: 'Unseen provider edit' }));
    const paused = gate();
    const release = gate();
    fake.hooks.beforeItem = async (_calendar, item) => {
      if (item.kind === 'end') { paused.open(); await release.promise; }
    };
    const [job] = await claim('pending-write', { leaseMs: 30_000, limit: 1, ids: [(await target()).id] });
    if (!job) throw new Error('No claimed job');
    const running = syncHandlers(deps).events(job, new AbortController().signal);
    let writes = 0;
    fake.hooks.beforeWrite = async () => { writes++; };
    try {
      await paused.promise;
      const [pending] = await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
      expect(pending?.dirty).toBe(true);
      expect(pending?.etag).toBe(provider.objects.get(upstreamId)!.etag);
      expect((await request('GET', 'pending.ics')).headers.get('etag')).toBe(oldEtag);
      expect((await request('PUT', 'pending.ics', body('pending', 'Overwrite'), { 'If-Match': oldEtag })).status).toBe(412);
      expect((await request('DELETE', 'pending.ics', undefined, { 'If-Match': oldEtag })).status).toBe(412);
      expect(writes).toBe(0);
      expect(provider.objects.get(upstreamId)?.payload).toContain('Unseen provider edit');
    } finally { release.open(); }
    const outcome = await running;
    await complete(job, { ok: true, nextRunInMs: outcome.nextRunInMs });
    const [published] = await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
    expect(published?.dirty).toBe(false);
    const fresh = await request('GET', 'pending.ics');
    expect(await fresh.text()).toContain('SUMMARY:Unseen provider edit');
    expect(fresh.headers.get('etag')).not.toBe(oldEtag);
    expect((await request('PUT', 'pending.ics', body('pending'), { 'If-Match': oldEtag })).status).toBe(412);
    expect((await request('PUT', 'pending.ics', body('pending', 'Refetched edit'), { 'If-Match': fresh.headers.get('etag')! })).status).toBe(204);
    expect(writes).toBe(1);
  });

  test('provider timeout returns a gateway error and stores nothing', async () => {
    const { fake, calendar, request } = await setup();
    fake.hooks.beforeWrite = (ctx) => new Promise((_, reject) => {
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
    });
    const response = await request('PUT', 'timeout.ics', body('timeout'));
    expect([502, 503]).toContain(response.status);
    expect(await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id))).toEqual([]);
    expect(await unsafeDb().select().from(resource).where(eq(resource.sourceCalendarId, calendar.id))).toEqual([]);
    expect(fake.calendar('work').objects.size).toBe(0);
  }, 30_000);

  test('throttling includes Retry-After, outages store nothing, and object refusals leave the account active', async () => {
    const { fake, calendar, account, request } = await setup();
    for (const [error, status] of [[new ProviderThrottledError(2500), 503], [new ProviderUnavailableError('offline'), 502],
      [new ProviderWriteRejectedError('read-only', 'denied'), 403], [new ProviderWriteRejectedError('invalid-data', 'bad'), 403],
      [new ProviderWriteRejectedError('quota', 'full'), 507], [new ProviderWriteRejectedError('not-found', 'gone'), 412]] as const) {
      fake.fail({ at: 'write', error });
      const response = await request('PUT', 'rejected.ics', body('rejected'));
      expect(response.status).toBe(status);
      if (status === 503) expect(response.headers.get('retry-after')).toBe('3');
    }
    expect(await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id))).toEqual([]);
    const [row] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id));
    expect(row?.status).toBe('active');
  });

  test('an authentication failure during refresh uses the shared reauth transition', async () => {
    const { fake, account, request, target } = await setup();
    fake.hooks.beforeWrite = async () => { throw new AuthFailedError('invalid_grant'); };
    expect((await request('PUT', 'auth.ics', body('auth'))).status).toBe(403);
    const [row] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id));
    expect(row?.status).toBe('reauth_required');
    const [parked] = await unsafeDb().select({ parked: sql<boolean>`${syncTarget.nextRunAt} = 'infinity'::timestamptz` }).from(syncTarget).where(eq(syncTarget.id, (await target()).id));
    expect(parked?.parked).toBe(true);
  });

  test('missing write capability advertises read privileges and refuses object and collection mutations', async () => {
    const { calendar, request } = await setup({ writable: false });
    // Exercise legacy JSON rows whose capability has no write key.
    await unsafeDb().update(sourceCalendar).set({ capabilities: sql`${sourceCalendar.capabilities} - 'write'` }).where(eq(sourceCalendar.id, calendar.id));
    const props = await request('PROPFIND', '', undefined, { Depth: '0' });
    const text = await props.text();
    expect(text).toContain('<d:read/>');
    expect(text).not.toContain('<d:write-content/>');
    for (const method of ['PUT', 'DELETE']) expect((await request(method, 'read.ics', method === 'PUT' ? body('read') : undefined)).status).toBe(403);
    for (const method of ['DELETE', 'PROPPATCH', 'MKCALENDAR']) {
      const response = await request(method);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('need-privileges');
    }
  });

  test('object-name rows have tenant RLS and calendar-scoped uniqueness', async () => {
    const { calendar, request } = await setup();
    expect((await request('PUT', 'name.ics', body('names'))).status).toBe(201);
    expect(await withTenant('org_elsewhere' as typeof DEVICE.tenantId, (tx) => tx.select().from(davObjectName))).toEqual([]);
    expect(await sqlState(withTenant(DEVICE.tenantId, (tx) => tx.insert(davObjectName).values({ tenantId: DEVICE.tenantId, sourceCalendarId: calendar.id, uid: 'another-uid', objectName: 'name.ics' })))).toBe('23505');
    expect(await sqlState(withTenant(DEVICE.tenantId, (tx) => tx.insert(davObjectName).values({ tenantId: DEVICE.tenantId, sourceCalendarId: calendar.id, uid: 'names', objectName: 'another-name.ics' })))).toBe('23505');
    const second = await setup();
    expect((await second.request('PUT', 'name.ics', body('names'))).status).toBe(201);

    expect(await sqlState(withTenant('org_elsewhere' as typeof DEVICE.tenantId, (tx) => tx.insert(davObjectName).values({ tenantId: DEVICE.tenantId, sourceCalendarId: calendar.id, uid: 'other', objectName: 'other.ics' })))).toBe('42501');
  });
});
