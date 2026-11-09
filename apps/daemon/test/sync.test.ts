/**
 * The sync engine over a scratch database and the fake adapter: lease fencing of page and end
 * transactions, replay after a failed page, the snapshot sweep, wake-ups during a run, lease
 * renewal and abort, account status, discovery, seq economy and re-normalisation.
 */
import { summary } from '@supercal/core';
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
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Principal } from '../src/auth/principal.ts';
import { startBus, type BusEvents } from '../src/bus.ts';
import { createLogger } from '../src/log.ts';
import { connectAccount } from '../src/sync/accounts.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { registerMaintenance } from '../src/sync/maintenance.ts';
import { claim, complete, LeaseLostError, startScheduler, StopTargetError, wakeTargets, type Job } from '../src/sync/scheduler.ts';
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
      const [work] = calendars as [SourceCalendar];
      const id = await targetOf('events', work.id);
      expect(await syncOnce(id)).toBeUndefined();

      fake.fail({ at: 'end', error: new AuthFailedError('token revoked') });
      expect(await syncOnce(id)).toBeInstanceOf(StopTargetError);
      const [after] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, account.id));
      expect(after).toMatchObject({ status: 'reauth_required', statusDetail: 'token revoked' });
      const parked = await unsafeDb()
        .select({ due: sql<boolean>`${syncTarget.nextRunAt} = 'infinity'` })
        .from(syncTarget)
        .where(sql`${syncTarget.targetId} in (${account.id}, ${work.id}, ${(calendars[1] as SourceCalendar).id})`);
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
    expect(done).toEqual({ dirty: false, version: 1 });
  });
});
