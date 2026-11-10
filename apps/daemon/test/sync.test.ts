/**
 * The sync engine over a scratch database and the fake adapter: lease fencing of page and end
 * transactions, replay after a failed page, the snapshot sweep, wake-ups during a run, lease
 * renewal and abort, account status, discovery, seq economy and re-normalisation.
 */
import { normalizers, summary } from '@supercal/core';
import {
  calendarAccount,
  closeDb,
  connectDb,
  member,
  migrate,
  organization,
  publication,
  publicationSource,
  resource,
  sink,
  sourceCalendar,
  sourceObject,
  syncTarget,
  user,
  withControl,
  type SourceCalendar,
  type SourceCalendarId,
  type SyncTargetId,
  type TenantId,
} from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { AuthFailedError, createGuardedFetch, ProviderThrottledError, ProviderUnavailableError, type ProviderAdapter } from '@supercal/providers';
import { createFakeAdapter, fakeEvent, type FakeProvider } from '@supercal/providers/test/fake';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Principal } from '../src/auth/principal.ts';
import { startBus, type BusEvents } from '../src/bus.ts';
import { createLogger } from '../src/log.ts';
import { connectAccount } from '../src/sync/accounts.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { registerMaintenance } from '../src/sync/maintenance.ts';
import { AccountBusyError, claim, complete, createSlots, defer, LeaseLostError, startScheduler, StopTargetError, wakeTargets, type Job, type JobHandler } from '../src/sync/scheduler.ts';
import { testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const alice: Principal = { kind: 'user', userId: `user_alice_${crypto.randomUUID().slice(0, 8)}`, tenantId, role: 'member', via: 'session', isOperator: false };

const lines: string[] = [];
const log = createLogger({}, (line) => void lines.push(line));
const adapters: { ics?: ProviderAdapter<unknown> } = {};
const deps = createSyncDeps({ secrets: testSecrets, fetch: createGuardedFetch({ allow: [] }), log, adapters });
const handlers = syncHandlers(deps);
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;

/** Connects an ICS account for Alice through the shared flow, listing `fake`'s calendars. */
async function connect(fake: FakeProvider) {
  adapters.ics = fake.adapter;
  return connectAccount(deps, alice, { credentials: { provider: 'ics', url: 'https://calendars.example.test/a.ics' }, displayName: 'Alice' });
}

async function targetOf(kind: 'events' | 'discover', targetId: string): Promise<SyncTargetId> {
  const [row] = await unsafeDb().select({ id: syncTarget.id }).from(syncTarget).where(and(eq(syncTarget.kind, kind), eq(syncTarget.targetId, targetId)));
  if (!row) throw new Error(`no ${kind} target for ${targetId}`);
  return row.id;
}

const target = async (id: SyncTargetId) => {
  const [row] = await unsafeDb()
    .select({
      cursor: syncTarget.cursor,
      lastError: syncTarget.lastError,
      retryAfter: syncTarget.retryAfter,
      attempts: syncTarget.attempts,
      dueIn: sql<number>`extract(epoch from ${syncTarget.nextRunAt} - clock_timestamp())::float8`,
    })
    .from(syncTarget)
    .where(eq(syncTarget.id, id));
  if (!row) throw new Error(`no target ${id}`);
  return row;
};

/** Claims `id` (made due first) as `owner`, without lease renewal. */
async function claimNow(id: SyncTargetId, owner = 'test', leaseMs = 30_000): Promise<Job> {
  await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp()` }).where(eq(syncTarget.id, id));
  const [job] = await claim(owner, { leaseMs, limit: 1, ids: [id] });
  if (!job) throw new Error(`could not claim ${id}`);
  return job;
}

/** Runs `job` through its handler and completes it, as the scheduler does. Returns the error, if any. */
async function run(job: Job): Promise<unknown> {
  try {
    const { nextRunInMs } = await handlers[job.kind](job, new AbortController().signal);
    await complete(job, { ok: true, nextRunInMs });
    return undefined;
  } catch (error) {
    if (!(error instanceof LeaseLostError)) await complete(job, { ok: false, error });
    return error;
  }
}

const syncOnce = async (id: SyncTargetId) => run(await claimNow(id));

/** Each live resource's SUMMARY by UID, and `null` for tombstones. */
async function summaries(calendarId: SourceCalendarId) {
  const rows = await unsafeDb().select().from(resource).where(eq(resource.sourceCalendarId, calendarId)).orderBy(resource.uid);
  return Object.fromEntries(rows.map((r) => [r.uid, r.data?.master ? summary(r.data.master) : null]));
}

const changeSeq = async () => (await unsafeDb().execute<{ last_value: string }>(sql`select last_value from change_seq`))[0]?.last_value;

/** Parks every target except `ids`, so a scheduler loop only finds these. */
const only = (ids: SyncTargetId[]) =>
  unsafeDb()
    .update(syncTarget)
    .set({ nextRunAt: sql`'infinity'::timestamptz` })
    .where(sql`${syncTarget.id} not in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);

/** A promise and the function that settles it. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Polls `check` every 20 ms until it holds, for up to `ms`. */
async function eventually(check: () => boolean | Promise<boolean>, ms = 10_000) {
  for (const deadline = Date.now() + ms; !(await check()); await Bun.sleep(20)) if (Date.now() > deadline) throw new Error('timed out');
}

describe.skipIf(!testDatabaseUrl)('sync engine', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('sync');
    await migrate(scratch.url);
    connectDb(scratch.url);
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'T', slug: tenantId, createdAt: now });
    await unsafeDb().insert(user).values({ id: alice.userId, name: 'Alice', email: 'alice@example.com', updatedAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: alice.userId, role: 'member', createdAt: now });
  });

  afterAll(async () => {
    await closeDb();
    await scratch?.drop();
  });

  test('a worker whose lease was taken over commits neither its page nor its end', async () => {
    const fake = createFakeAdapter();
    fake.calendar('work').put('e1', fakeEvent('e1@test', { summary: 'v1' }));
    const { calendars } = await connect(fake);
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);

    // A pauses before its first page, past its 200 ms lease; B claims, syncs v2 and completes.
    const pageGate = gate();
    const endGate = gate();
    const reached = { page: gate(), end: gate() };
    fake.hooks.beforeItem = async (_calendar, item) => {
      const nth = fake.syncs.get('work');
      if (nth === 1 && item.kind === 'page') (reached.page.open(), await pageGate.opened);
      if (nth === 3 && item.kind === 'end') (reached.end.open(), await endGate.opened);
    };
    const a = await claimNow(id, 'A', 200);
    const pausedAtPage = run(a);
    await reached.page.opened;
    await Bun.sleep(300);
    fake.calendar('work').put('e1', fakeEvent('e1@test', { summary: 'v2', sequence: 1 }));
    expect(await syncOnce(id)).toBeUndefined();
    pageGate.open();
    expect(await pausedAtPage).toBeInstanceOf(LeaseLostError);
    expect(await summaries(calendarId)).toEqual({ 'e1@test': 'v2' });

    // A's third run writes its page in time, then pauses before end while B takes over with v4.
    fake.calendar('work').put('e1', fakeEvent('e1@test', { summary: 'v3', sequence: 2 }));
    const a2 = await claimNow(id, 'A', 200);
    const pausedAtEnd = run(a2);
    await reached.end.opened;
    await Bun.sleep(300);
    fake.calendar('work').put('e1', fakeEvent('e1@test', { summary: 'v4', sequence: 3 }));
    expect(await syncOnce(id)).toBeUndefined();
    endGate.open();
    expect(await pausedAtEnd).toBeInstanceOf(LeaseLostError);
    expect(await complete(a2, { ok: true, nextRunInMs: 0 })).toBe(false);
    expect(await summaries(calendarId)).toEqual({ 'e1@test': 'v4' });
  });

  test('a failure in page 2 of 3 keeps the cursor and every resource; the next run replays', async () => {
    const fake = createFakeAdapter({ pageSize: 1 });
    const work = fake.calendar('work');
    for (const n of [1, 2, 3]) work.put(`e${n}`, fakeEvent(`e${n}@test`, { summary: 'old' }));
    const { calendars } = await connect(fake);
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);
    expect(await syncOnce(id)).toBeUndefined();
    const before = await target(id);

    work.put('e1', fakeEvent('e1@test', { summary: 'new', sequence: 1 })).remove('e2').put('e4', fakeEvent('e4@test', { summary: 'new' }));
    fake.fail({ calendar: 'work', at: 2, error: new ProviderUnavailableError('page 2 broke') });
    expect(await syncOnce(id)).toBeInstanceOf(ProviderUnavailableError);
    const failed = await target(id);
    expect(failed.cursor).toEqual(before.cursor);
    expect(failed.lastError).toBe('page 2 broke');
    expect(await summaries(calendarId)).toEqual({ 'e1@test': 'old', 'e2@test': 'old', 'e3@test': 'old' });

    expect(await syncOnce(id)).toBeUndefined();
    expect(await summaries(calendarId)).toEqual({ 'e1@test': 'new', 'e2@test': null, 'e3@test': 'old', 'e4@test': 'new' });
    expect((await target(id)).cursor).not.toEqual(before.cursor);
  });

  test('Google strings jsonb cannot store keep last good groups while an honest delta edit commits', async () => {
    const fake = createFakeAdapter();
    const work = fake.calendar('work');
    const event = (id: string, title: string) => ({ groupUid: `${id}@test`, payload: JSON.stringify({ id, iCalUID: `${id}@test`, summary: title,
      start: { dateTime: '2026-11-09T09:00:00Z' }, end: { dateTime: '2026-11-09T10:00:00Z' } }) });
    for (const id of ['null', 'surrogate', 'honest']) work.put(id, event(id, 'old'));
    const { calendars } = await connect(fake);
    // The fake transports provider JSON; use the same normalizer as the real Google adapter.
    adapters.ics = { ...fake.adapter, format: 'google' };
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);
    expect(await syncOnce(id)).toBeUndefined();
    work.put('null', event('null', 'bad\0title')).put('surrogate', event('surrogate', 'bad\ud800title')).put('honest', event('honest', 'edited'));
    expect(await syncOnce(id)).toBeUndefined();
    expect(await summaries(calendarId)).toEqual({ 'null@test': 'old', 'surrogate@test': 'old', 'honest@test': 'edited' });
    const rows = await unsafeDb().select().from(resource).where(eq(resource.sourceCalendarId, calendarId));
    for (const uid of ['null@test', 'surrogate@test']) expect(rows.find((r) => r.uid === uid)).toMatchObject({ completeness: 'incomplete', completenessReason: 'Object contains a string PostgreSQL cannot store' });
    expect(rows.find((r) => r.uid === 'honest@test')?.completeness).toBe('complete');
  });

  test('a snapshot that no longer lists an object deletes it only at end', async () => {
    const fake = createFakeAdapter({ mode: 'snapshot' });
    fake.calendar('work').put('a', fakeEvent('a@test')).put('b', fakeEvent('b@test'));
    const { calendars } = await connect(fake);
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);
    expect(await syncOnce(id)).toBeUndefined();

    fake.calendar('work').remove('b');
    const reached = gate();
    const proceed = gate();
    fake.hooks.beforeItem = async (_calendar, item) => {
      if (item.kind === 'end') (reached.open(), await proceed.opened);
    };
    const running = syncOnce(id);
    await reached.opened;
    const objects = await unsafeDb().select({ id: sourceObject.providerObjectId }).from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendarId));
    expect(objects.map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(await summaries(calendarId)).toEqual({ 'a@test': 'a@test', 'b@test': 'b@test' });
    proceed.open();
    expect(await running).toBeUndefined();
    expect(await summaries(calendarId)).toEqual({ 'a@test': 'a@test', 'b@test': null });
  });

  test('unchanged resources across a full resync allocate no seq', async () => {
    const fake = createFakeAdapter({ mode: 'snapshot' });
    for (const n of [1, 2, 3]) fake.calendar('work').put(`e${n}`, fakeEvent(`e${n}@test`));
    const { calendars } = await connect(fake);
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);
    expect(await syncOnce(id)).toBeUndefined();

    const seq = await changeSeq();
    expect(await syncOnce(id)).toBeUndefined();
    // Even when every object must be re-normalised, equal revisions allocate nothing.
    await unsafeDb().update(sourceObject).set({ dirty: true }).where(eq(sourceObject.sourceCalendarId, calendarId));
    expect(await syncOnce(id)).toBeUndefined();
    expect(await changeSeq()).toBe(seq);
  });

  test('a wake during a run makes the target run again at once', async () => {
    const fake = createFakeAdapter();
    fake.calendar('work').put('a', fakeEvent('a@test'));
    const { calendars } = await connect(fake);
    const id = await targetOf('events', (calendars[0] as SourceCalendar).id);
    await only([id]);
    await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp()` }).where(eq(syncTarget.id, id));

    const reached = gate();
    const proceed = gate();
    fake.hooks.beforeItem = async (_calendar, item) => {
      if (item.kind === 'end' && fake.syncs.get('work') === 1) (reached.open(), await proceed.opened);
    };
    const stop = new AbortController();
    // Polling far less often than the test waits: only the wake can explain a second run.
    const scheduler = startScheduler({ handlers, log, signal: stop.signal, pollMs: 60_000, leaseMs: 10_000 });
    await reached.opened;
    await withControl((tx) => wakeTargets(tx, [id]));
    proceed.open();
    await eventually(() => fake.syncs.get('work') === 2);
    stop.abort();
    await scheduler;
    // Without the wake the next run is the ICS cadence away (minutes).
    expect((await target(id)).dueIn).toBeGreaterThan(60);
  });

  test('a lease is renewed while a long run works, and the run aborts when the lease is lost', async () => {
    const fake = createFakeAdapter({ pageSize: 1, delayMs: 250 });
    for (const n of [1, 2, 3]) fake.calendar('work').put(`e${n}`, fakeEvent(`e${n}@test`));
    const { calendars } = await connect(fake);
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);
    await only([id]);
    await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp()` }).where(eq(syncTarget.id, id));
    const lease = async () => (await unsafeDb().select({ owner: syncTarget.leaseOwner }).from(syncTarget).where(eq(syncTarget.id, id)))[0]?.owner;

    // Four items at 250 ms each outlive a 300 ms lease many times over.
    const bus = await startBus(scratch?.url ?? '', log);
    const stop = new AbortController();
    const scheduler = startScheduler({ handlers, log, signal: stop.signal, bus, pollMs: 60_000, leaseMs: 300 });
    try {
      await eventually(async () => Object.keys(await summaries(calendarId)).length === 3 && (await lease()) === null);
      expect(lines.some((line) => line.includes('lease lost'))).toBe(false);

      // Another claim replaces the lease mid-run: renewal fails and the run stops without writing.
      fake.calendar('work').put('e4', fakeEvent('e4@test'));
      const started = gate();
      fake.hooks.beforeItem = async () => started.open();
      await withControl((tx) => wakeTargets(tx, [id]));
      await started.opened;
      await unsafeDb()
        .update(syncTarget)
        .set({ leaseOwner: 'thief', leaseVersion: sql`${syncTarget.leaseVersion} + 1`, leaseUntil: sql`clock_timestamp() + interval '1 hour'` })
        .where(eq(syncTarget.id, id));
      await eventually(() => lines.some((line) => line.includes('job stopped: lease lost')));
      expect(Object.keys(await summaries(calendarId))).not.toContain('e4@test');
    } finally {
      stop.abort();
      await scheduler;
      await bus.close();
    }
  });

  test('throttling waits at least the retry-after', async () => {
    const fake = createFakeAdapter();
    fake.calendar('work').put('a', fakeEvent('a@test'));
    const { calendars } = await connect(fake);
    const id = await targetOf('events', (calendars[0] as SourceCalendar).id);
    fake.fail({ at: 1, error: new ProviderThrottledError(600_000) });
    expect(await syncOnce(id)).toBeInstanceOf(ProviderThrottledError);
    const row = await target(id);
    expect(row.dueIn).toBeGreaterThan(590);
    expect(row.retryAfter).not.toBeNull();
  });

  test('auth failure requires reauth and stops the account, while its publications keep serving', async () => {
    const events: BusEvents['event'][] = [];
    const bus = await startBus(scratch?.url ?? '', log);
    bus.on('event', (e) => events.push(e));
    try {
      const fake = createFakeAdapter();
      fake.calendar('work').put('a', fakeEvent('a@test'));
      fake.calendar('home').put('h', fakeEvent('h@test'));
      const { account, calendars } = await connect(fake);
      const work = calendars.find((c) => c.providerCalendarId === 'work') as SourceCalendar;
      const id = await targetOf('events', work.id);
      expect(await syncOnce(id)).toBeUndefined();

      fake.fail({ at: 'end', error: new AuthFailedError('token revoked') });
      expect(await syncOnce(id)).toBeInstanceOf(StopTargetError);
      const [after] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id));
      expect(after).toMatchObject({ status: 'reauth_required', statusDetail: 'token revoked' });
      const parked = await unsafeDb()
        .select({ due: sql<boolean>`${syncTarget.nextRunAt} = 'infinity'` })
        .from(syncTarget)
        .where(sql`${syncTarget.targetId} in (${account.id}, ${work.id}, ${(calendars.find((c) => c.providerCalendarId === 'home') as SourceCalendar).id})`);
      expect(parked).toEqual([{ due: true }, { due: true }, { due: true }]);

      const published = await unsafeDb()
        .select({ enabled: publication.enabled })
        .from(publication)
        .innerJoin(publicationSource, eq(publicationSource.publicationId, publication.id))
        .where(eq(publicationSource.sourceCalendarId, work.id));
      expect(published).toEqual([{ enabled: true }]);
      expect(await summaries(work.id)).toEqual({ 'a@test': 'a@test' });
      const [stale] = await unsafeDb().select({ freshness: sourceCalendar.freshness }).from(sourceCalendar).where(eq(sourceCalendar.id, work.id));
      expect(stale?.freshness).toMatchObject({ stale: true });
      await eventually(() => events.some((e) => e.event.type === 'account.status' && e.event.status === 'reauth_required'));
    } finally {
      await bus.close();
    }
  });

  test('ten failures in a row show the account as error, and a success makes it active again', async () => {
    const fake = createFakeAdapter();
    fake.calendar('work').put('a', fakeEvent('a@test'));
    const { account, calendars } = await connect(fake);
    const id = await targetOf('events', (calendars[0] as SourceCalendar).id);
    const status = async () => (await unsafeDb().select({ status: calendarAccount.status }).from(calendarAccount).where(eq(calendarAccount.id, account.id)))[0]?.status;

    await unsafeDb().update(syncTarget).set({ attempts: 8 }).where(eq(syncTarget.id, id));
    fake.fail({ at: 'end', error: new ProviderUnavailableError('down'), times: 2 });
    await syncOnce(id);
    expect(await status()).toBe('active');
    await syncOnce(id);
    expect(await status()).toBe('error');
    expect(await syncOnce(id)).toBeUndefined();
    expect(await status()).toBe('active');
  });

  test('discovery publishes new calendars, marks missing ones gone only after a good listing, and never ingests sinks', async () => {
    const fake = createFakeAdapter();
    fake.calendar('work');
    fake.calendar('home');
    const { account } = await connect(fake);
    const discover = await targetOf('discover', account.id);
    const calendarsOf = () => unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.accountId, account.id));

    // A sink writing into this account's 'mirror' calendar.
    await unsafeDb().update(calendarAccount).set({ providerSubject: 'subject-1' }).where(eq(calendarAccount.id, account.id));
    const [anyPublication] = await unsafeDb().select({ id: publication.id }).from(publication).limit(1);
    if (!anyPublication) throw new Error('no publication');
    await unsafeDb()
      .insert(sink)
      .values({ tenantId, publicationId: anyPublication.id, accountId: account.id, provider: 'ics', providerSubject: 'subject-1', providerCalendarId: 'mirror' });
    fake.calendar('mirror');
    fake.calendar('trips');
    expect(await syncOnce(discover)).toBeUndefined();
    const found = await calendarsOf();
    expect(found.map((c) => c.providerCalendarId).sort()).toEqual(['home', 'trips', 'work']);
    const trips = found.find((c) => c.providerCalendarId === 'trips') as SourceCalendar;
    const tripsTarget = await target(await targetOf('events', trips.id));
    expect(tripsTarget.dueIn).toBeLessThanOrEqual(0);
    const tripsPublications = await unsafeDb().select().from(publicationSource).where(eq(publicationSource.sourceCalendarId, trips.id));
    expect(tripsPublications).toHaveLength(1);

    const home = found.find((c) => c.providerCalendarId === 'home') as SourceCalendar;
    fake.calendars.delete('home');
    fake.fail({ at: 'list', error: new ProviderUnavailableError('listing failed') });
    expect(await syncOnce(discover)).toBeInstanceOf(ProviderUnavailableError);
    expect((await calendarsOf()).find((c) => c.id === home.id)?.state).toBe('active');

    expect(await syncOnce(discover)).toBeUndefined();
    expect((await calendarsOf()).find((c) => c.id === home.id)?.state).toBe('gone');
    expect(await unsafeDb().select().from(syncTarget).where(eq(syncTarget.targetId, home.id))).toEqual([]);
    const [homePublication] = await unsafeDb()
      .select({ enabled: publication.enabled, status: publication.status })
      .from(publication)
      .innerJoin(publicationSource, eq(publicationSource.publicationId, publication.id))
      .where(eq(publicationSource.sourceCalendarId, home.id));
    expect(homePublication).toEqual({ enabled: false, status: 'disabled-invalid' });
  });

  test('re-normalisation marks rows from an older normaliser dirty and wakes their targets', async () => {
    const fake = createFakeAdapter();
    fake.calendar('work').put('a', fakeEvent('a@test'));
    const { calendars } = await connect(fake);
    const calendarId = (calendars[0] as SourceCalendar).id;
    const id = await targetOf('events', calendarId);
    expect(await syncOnce(id)).toBeUndefined();
    await unsafeDb().update(sourceObject).set({ normalizerVersion: 0 }).where(eq(sourceObject.sourceCalendarId, calendarId));
    await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp() + interval '1 hour'` }).where(eq(syncTarget.id, id));

    await registerMaintenance();
    const [maintenance] = await unsafeDb()
      .select({ id: syncTarget.id })
      .from(syncTarget)
      .where(and(eq(syncTarget.targetId, 'renormalize'), ne(syncTarget.kind, 'events')));
    if (!maintenance) throw new Error('renormalize is not registered');
    expect(await syncOnce(maintenance.id)).toBeUndefined();
    const [row] = await unsafeDb().select({ dirty: sourceObject.dirty }).from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendarId));
    expect(row?.dirty).toBe(true);
    expect((await target(id)).dueIn).toBeLessThanOrEqual(0);

    expect(await syncOnce(id)).toBeUndefined();
    const [done] = await unsafeDb().select({ dirty: sourceObject.dirty, version: sourceObject.normalizerVersion }).from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendarId));
    expect(done).toMatchObject({ dirty: false, version: normalizers.ical?.version });
  });

  test.each([{ targets: 8, workers: 1 }, { targets: 16, workers: 2 }])(
    '$workers scheduler(s) keep a busy CalDAV account from starving another tenant with $targets targets',
    async ({ targets, workers }) => {
      const otherTenant = `org_${crypto.randomUUID()}` as TenantId;
      await unsafeDb().insert(organization).values({ id: otherTenant, name: 'Other', slug: otherTenant, createdAt: new Date() });
      await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: otherTenant, userId: alice.userId, role: 'member', createdAt: new Date() });
      const fake = createFakeAdapter({ provider: 'caldav' });
      for (let i = 0; i < targets; i++) fake.calendar(`busy-${i}`);
      const localDeps = createSyncDeps({ secrets: testSecrets, fetch: deps.fetch, log, adapters: { caldav: fake.adapter } });
      const { calendars } = await connectAccount(localDeps, { ...alice, tenantId: otherTenant }, {
        credentials: { provider: 'caldav', serverUrl: 'https://dav.test', username: 'alice', password: 'test' }, displayName: 'Busy',
      });
      const ids = await Promise.all(calendars.map((c) => targetOf('events', c.id)));
      const [other] = await unsafeDb().insert(syncTarget).values({ tenantId, kind: 'events', targetId: crypto.randomUUID() }).returning();
      if (!other) throw new Error('target insert failed');
      await only([...ids, other.id]);
      let active = 0;
      let maxActive = 0;
      const unblock = gate();
      fake.hooks.beforeItem = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try { await unblock.opened; } finally { active--; }
      };
      let otherRan = false;
      const localHandlers = syncHandlers(localDeps);
      const fairHandlers = { ...localHandlers, events: async (job: Job, signal: AbortSignal) => {
        if (job.id === other.id) { otherRan = true; return { nextRunInMs: Infinity }; }
        return localHandlers.events(job, signal);
      } };
      const stop = new AbortController();
      const schedulers = Array.from({ length: workers }, () => startScheduler({ handlers: fairHandlers, log, signal: stop.signal, concurrency: 8, pollMs: 20 }));
      try {
        await eventually(() => otherRan && active === 2, 1_000);
        await eventually(async () => (await unsafeDb().select().from(syncTarget)
          .where(and(inArray(syncTarget.id, ids), sql`${syncTarget.leaseOwner} is not null`))).length === 2, 1_000);
        expect(maxActive).toBe(2);
        const deferred = await unsafeDb().select().from(syncTarget).where(and(inArray(syncTarget.id, ids), sql`${syncTarget.leaseVersion} > 0`, sql`${syncTarget.leaseOwner} is null`));
        expect(deferred.length).toBeGreaterThan(0);
        for (const row of deferred) expect(row).toMatchObject({ attempts: 0, lastSuccessAt: null, lastError: null });
      } finally {
        stop.abort();
        unblock.open();
        await Promise.all(schedulers);
      }
    },
  );

  test('one tenant stays within its cap and every due target eventually finishes', async () => {
    const rows = await unsafeDb().insert(syncTarget).values(Array.from({ length: 12 }, () => ({ tenantId, kind: 'events' as const, targetId: crypto.randomUUID() }))).returning();
    await only(rows.map((r) => r.id));
    let active = 0;
    let maxActive = 0;
    const handler: JobHandler = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(80);
      active--;
      return { nextRunInMs: Infinity };
    };
    const stop = new AbortController();
    const scheduler = startScheduler({ handlers: { ...handlers, events: handler }, log, signal: stop.signal, concurrency: 8, pollMs: 10 });
    try {
      await eventually(async () => (await unsafeDb().select().from(syncTarget)
        .where(and(inArray(syncTarget.id, rows.map((r) => r.id)), sql`${syncTarget.lastSuccessAt} is not null`))).length === rows.length);
      expect(maxActive).toBe(4);
    } finally { stop.abort(); await scheduler; }
  });

  test('the job deadline records its reason, backs off and frees the slot', async () => {
    const rows = await unsafeDb().insert(syncTarget).values([0, 1].map(() => ({ tenantId, kind: 'events' as const, targetId: crypto.randomUUID() }))).returning();
    const [blocked, following] = rows;
    if (!blocked || !following) throw new Error('target insert failed');
    await only(rows.map((r) => r.id));
    // Make the blocked job unambiguously first in the due order.
    await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp() - interval '1 hour'` }).where(eq(syncTarget.id, blocked.id));
    let followingRan = false;
    const handler: JobHandler = async (job, signal) => {
      if (job.id === following.id) { followingRan = true; return { nextRunInMs: Infinity }; }
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true }));
      return { nextRunInMs: Infinity };
    };
    const stop = new AbortController();
    const scheduler = startScheduler({ handlers: { ...handlers, events: handler }, log, signal: stop.signal, concurrency: 1, pollMs: 10, jobDeadlineMs: 100 });
    try {
      await eventually(() => followingRan, 1_000);
      const row = await target(blocked.id);
      expect(row.lastError).toBe('the job ran past its deadline');
      expect(row.dueIn).toBeGreaterThan(0);
      expect(row.attempts).toBe(1);
      const [stored] = await unsafeDb().select().from(syncTarget).where(eq(syncTarget.id, blocked.id));
      expect(stored?.leaseOwner).toBeNull();
    } finally { stop.abort(); await scheduler; }
  });

  test('a busy account refuses immediately; deferring preserves attempts, success and error history', async () => {
    const slots = createSlots(1);
    const held = gate();
    const running = slots('account', () => held.opened);
    try { await expect(slots('account', async () => {})).rejects.toBeInstanceOf(AccountBusyError); }
    finally { held.open(); await running; }
    await slots('account', async () => {});
    const [row] = await unsafeDb().insert(syncTarget).values({ tenantId, kind: 'events', targetId: crypto.randomUUID(), attempts: 3, lastError: 'previous failure', lastSuccessAt: new Date('2026-01-01') }).returning();
    if (!row) throw new Error('target insert failed');
    const job = await claimNow(row.id, 'deferred');
    await defer(job, 5_000);
    const [stored] = await unsafeDb().select().from(syncTarget).where(eq(syncTarget.id, row.id));
    expect(stored).toMatchObject({ attempts: 3, lastSuccessAt: row.lastSuccessAt, lastError: 'previous failure', leaseOwner: null, leaseUntil: null });
    expect((await target(row.id)).dueIn).toBeGreaterThan(4);
  });

  test('maintenance is exempt when a tenant has filled its share', async () => {
    const rows = await unsafeDb().insert(syncTarget).values(Array.from({ length: 6 }, () => ({ tenantId, kind: 'events' as const, targetId: crypto.randomUUID() }))).returning();
    const [maintenance] = await unsafeDb().insert(syncTarget).values({ kind: 'maintenance', targetId: crypto.randomUUID() }).returning();
    if (!maintenance) throw new Error('target insert failed');
    await only([...rows.map((r) => r.id), maintenance.id]);
    const jobs = await claim('cap', { leaseMs: 30_000, limit: 8, tenantCap: 4, ids: rows.map((r) => r.id) });
    expect(jobs).toHaveLength(4);
    const next = await claim('cap', { leaseMs: 30_000, limit: 8, tenantCap: 4 });
    expect(next.map((j) => j.id)).toEqual([maintenance.id]);
    await Promise.all([...jobs, ...next].map((j) => complete(j, { ok: true, nextRunInMs: Infinity })));
  });

  test('discovery selects a stable first 100 calendars and clears the quota detail when it fits', async () => {
    const fake = createFakeAdapter();
    for (let i = 119; i >= 0; i--) fake.calendar(`c${String(i).padStart(3, '0')}`);
    const { account, calendars } = await connect(fake);
    expect(calendars).toHaveLength(100);
    expect(calendars.map((c) => c.providerCalendarId)).toEqual(Array.from({ length: 100 }, (_, i) => `c${String(i).padStart(3, '0')}`));
    expect(account.statusDetail).toBe('Syncing the first 100 of 120 calendars');
    const discover = await targetOf('discover', account.id);
    expect(await syncOnce(discover)).toBeUndefined();
    expect(await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.accountId, account.id))).toHaveLength(100);
    for (let i = 90; i < 120; i++) fake.calendars.delete(`c${String(i).padStart(3, '0')}`);
    expect(await syncOnce(discover)).toBeUndefined();
    const [updated] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id));
    expect(updated?.statusDetail).toBeNull();
    expect(await unsafeDb().select().from(sourceCalendar).where(and(eq(sourceCalendar.accountId, account.id), eq(sourceCalendar.state, 'active')))).toHaveLength(90);
  });

  test('passing 50,000 raw objects parks the calendar and preserves its published data', async () => {
    const fake = createFakeAdapter();
    const work = fake.calendar('work').put('published', fakeEvent('published@test'));
    const { calendars } = await connect(fake);
    const calendar = calendars[0];
    if (!calendar) throw new Error('no calendar');
    const id = await targetOf('events', calendar.id);
    expect(await syncOnce(id)).toBeUndefined();
    // Seed the boundary directly; the run only has to write the object that crosses it.
    await unsafeDb().execute(sql`insert into source_object (tenant_id, source_calendar_id, provider_object_id, format, payload, etag, group_uid, seen_generation, dirty)
      select ${tenantId}, ${calendar.id}, 'seed-' || n, 'ical', '', '', 'seed-' || n, 0, false from generate_series(1, 49999) n`);
    work.put('extra', fakeEvent('extra@test'));
    expect(await syncOnce(id)).toBeInstanceOf(StopTargetError);
    expect(await target(id)).toMatchObject({ lastError: 'This calendar has more than 50,000 events', dueIn: Infinity });
    expect(await summaries(calendar.id)).toEqual({ 'published@test': 'published@test' });
  });

});
