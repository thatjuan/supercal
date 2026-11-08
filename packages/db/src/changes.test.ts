import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { join } from 'node:path';
import postgres from 'postgres';
import { CHANGES_CHANNEL, changesSince, publicationState, purgeTombstones, recordChanges, resourcesByUids, type ResourceChange } from './changes.ts';
import { newId, type SourceCalendarId, type TenantId } from './ids.ts';
import { migrate } from './migrate.ts';
import { calendarAccount, organization, sourceCalendar, systemSetting, user } from './schema/index.ts';
import { testDatabaseUrl } from './test-db.ts';
import { withControl, withTenant, type TenantTx } from './tx.ts';
import { closeDb, connectDb, unsafeDb } from './unsafe-db.ts';

test('nothing outside changes.ts writes resource', async () => {
  const root = join(import.meta.dir, '../../..');
  const writes = [/\.(insert|update|delete)\(\s*resource\s*\)/, /\b(insert\s+into|update|delete\s+from)\s+"?resource\b/i];
  const allowed = new Set(['packages/db/src/changes.ts']);
  const offenders: string[] = [];
  for (const dir of ['apps', 'packages'])
    for await (const file of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scan({ cwd: root })) {
      if (file.includes('node_modules') || allowed.has(file)) continue;
      const text = await Bun.file(join(root, file)).text();
      if (writes.some((pattern) => pattern.test(text))) offenders.push(file);
    }
  expect(offenders).toEqual([]);
});

const upsert = (sourceCalendarId: SourceCalendarId, uid: string, revision = 'r1'): ResourceChange => ({
  op: 'upsert',
  sourceCalendarId,
  uid,
  resource: { uid, master: null, overrides: [], timezones: {} },
  revision,
  sequence: null,
  lastModified: null,
  organizer: null,
  span: { start: new Date('2026-12-01T10:00:00Z'), end: new Date('2026-12-01T11:00:00Z') },
  completeness: 'complete',
});
const remove = (sourceCalendarId: SourceCalendarId, uid: string): ResourceChange => ({ op: 'delete', sourceCalendarId, uid });

/** Runs `fn` in some transaction that can read the change log. */
type Reading = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
const inTenant =
  (tenantId: TenantId): Reading =>
  (fn) =>
    withTenant(tenantId, fn);

/** Follows `changesSince` from `afterSeq` until it reports no more rows. */
async function readAll(read: Reading, ids: SourceCalendarId[], afterSeq: bigint) {
  const uids: string[] = [];
  let position = afterSeq;
  for (let more = true; more; ) {
    const page = await read((tx) => changesSince(tx, ids, position, 100));
    uids.push(...page.rows.map((row) => row.uid));
    position = page.maxSeq;
    more = page.hasMore;
  }
  return { uids, position };
}

/** Resolves once `check` passes, polling every 10 ms; rejects after `ms`. */
async function eventually(check: () => boolean, ms = 2000) {
  for (const deadline = Date.now() + ms; !check(); await Bun.sleep(10)) if (Date.now() > deadline) throw new Error('timed out');
}

const userId = `user_${crypto.randomUUID()}`;
const tenants = Array.from({ length: 8 }, () => `org_${crypto.randomUUID()}` as TenantId);
const calendars = tenants.map(() => newId('cal'));
const tenant = tenants[0] as TenantId;
const calendar = calendars[0] as SourceCalendarId;

describe.skipIf(!testDatabaseUrl)('change log', () => {
  beforeAll(async () => {
    const url = testDatabaseUrl ?? '';
    await migrate(url);
    connectDb(url);
    const db = unsafeDb();
    const now = new Date();
    await db.insert(user).values({ id: userId, name: 'Test', email: `${userId}@example.com`, updatedAt: now });
    await db.insert(organization).values(tenants.map((id) => ({ id, name: id, slug: id, createdAt: now })));
    const accounts = tenants.map((tenantId) => ({ id: newId('acc'), tenantId, ownerUserId: userId, provider: 'ics' as const, displayName: 'A' }));
    await db.insert(calendarAccount).values(accounts);
    await db.insert(sourceCalendar).values(
      accounts.map((account, i) => ({ id: calendars[i] as SourceCalendarId, tenantId: account.tenantId, accountId: account.id, providerCalendarId: `c${i}`, name: 'C' })),
    );
  });

  afterAll(async () => {
    await unsafeDb().delete(organization).where(inArray(organization.id, tenants));
    await unsafeDb().delete(user).where(eq(user.id, userId));
    await closeDb();
  });

  /** Runs 8 writers x 40 single-change transactions, each pausing 0-15 ms between recordChanges and commit. */
  async function race(name: string, writerTenant: (w: number) => number, read: Reading, ids: SourceCalendarId[]) {
    const committed = new Set<string>();
    const seen = new Set<string>();
    let done = false;
    const writer = async (w: number) => {
      const i = writerTenant(w);
      for (let n = 0; n < 40; n++) {
        const uid = `${name}-${w}-${n}`;
        await withTenant(tenants[i] as TenantId, async (tx) => {
          await recordChanges(tx, [upsert(calendars[i] as SourceCalendarId, uid)]);
          await Bun.sleep(Math.random() * 15); // seq taken, not yet committed
        });
        committed.add(uid);
      }
    };
    const reader = async () => {
      let position = 0n;
      for (let last = false; !last; await Bun.sleep(2)) {
        last = done; // one more pass after the writers finish
        const result = await readAll(read, ids, position);
        for (const uid of result.uids) if (uid.startsWith(`${name}-`)) seen.add(uid);
        position = result.position;
      }
    };
    const following = reader();
    await Promise.all(Array.from({ length: 8 }, (_, w) => writer(w)));
    done = true;
    await following;
    return { committed: committed.size, reported: seen.size, skipped: [...committed].filter((uid) => !seen.has(uid)).length };
  }

  test('8 concurrent writers x 40: a reader following changesSince misses nothing', async () => {
    expect(await race('locked', () => 0, inTenant(tenant), [calendar])).toEqual({ committed: 320, reported: 320, skipped: 0 });
  }, 30_000);

  // Why the lock exists. Each writer here is in its own tenant, so their advisory locks never
  // contend (the same as having no lock), while one reader spans all of them. A seq taken early and
  // committed late lands below the reader's position and is never reported.
  test('without a shared lock, a reader skips changes', async () => {
    const crossTenant: Reading = (fn) => unsafeDb().transaction((tx) => fn(tx as TenantTx));
    const result = await race('naive', (w) => w, crossTenant, calendars);
    expect(result.committed).toBe(320);
    expect(result.skipped).toBeGreaterThan(0);
  }, 30_000);

  test('an unchanged revision allocates no seq', async () => {
    await withTenant(tenant, (tx) => recordChanges(tx, [upsert(calendar, 'same')]));
    const sequenceValue = async () => (await unsafeDb().execute<{ v: string }>(sql`select last_value::text as v from change_seq`))[0]?.v;
    const before = await sequenceValue();
    const result = await withTenant(tenant, (tx) => recordChanges(tx, [upsert(calendar, 'same')]));
    expect(result).toEqual({ maxSeq: null, changed: 0 });
    expect(await sequenceValue()).toBe(before);
  });

  test('a delete leaves a tombstone with a new seq that changesSince reports', async () => {
    const { maxSeq: created } = await withTenant(tenant, (tx) => recordChanges(tx, [upsert(calendar, 'gone')]));
    const { maxSeq: deleted } = await withTenant(tenant, (tx) => recordChanges(tx, [remove(calendar, 'gone')]));
    expect(deleted).toBeGreaterThan(created ?? 0n);

    const { rows, maxSeq, hasMore } = await withTenant(tenant, (tx) => changesSince(tx, [calendar], created ?? 0n, 10));
    expect({ maxSeq, hasMore }).toEqual({ maxSeq: deleted ?? -1n, hasMore: false });
    expect(rows.map(({ uid, deleted, data, seq }) => ({ uid, deleted, data, seq }))).toEqual([{ uid: 'gone', deleted: true, data: null, seq: deleted ?? -1n }]);
    expect(await withTenant(tenant, (tx) => resourcesByUids(tx, [calendar], ['gone']))).toEqual([]);
    expect(await withTenant(tenant, (tx) => recordChanges(tx, [remove(calendar, 'gone')]))).toEqual({ maxSeq: null, changed: 0 });
  });

  test('changesSince pages by seq and resumes from maxSeq', async () => {
    const start = (await withTenant(tenant, (tx) => publicationState(tx, [calendar]))).maxSeq;
    await withTenant(tenant, (tx) => recordChanges(tx, ['p1', 'p2', 'p3'].map((uid) => upsert(calendar, uid))));
    const first = await withTenant(tenant, (tx) => changesSince(tx, [calendar], start, 2));
    const second = await withTenant(tenant, (tx) => changesSince(tx, [calendar], first.maxSeq, 2));
    expect([first.rows.map((r) => r.uid), first.hasMore, second.rows.map((r) => r.uid), second.hasMore]).toEqual([['p1', 'p2'], true, ['p3'], false]);
    expect(first.maxSeq).toBe(first.rows[1]?.seq ?? -1n);
    expect(second.maxSeq).toBe((await withTenant(tenant, (tx) => publicationState(tx, [calendar]))).maxSeq);
  });

  test('purgeTombstones raises the floor and deletes only old tombstones', async () => {
    const cal = calendars[1] as SourceCalendarId;
    const inSecond = inTenant(tenants[1] as TenantId);
    const write = (changes: ResourceChange[]) => inSecond((tx) => recordChanges(tx, changes));
    const start = (await inSecond((tx) => publicationState(tx, [cal]))).maxSeq;
    await write([upsert(cal, 'old'), upsert(cal, 'recent'), upsert(cal, 'live')]);
    const { maxSeq: oldSeq } = await write([remove(cal, 'old')]);
    await Bun.sleep(20);
    await write([remove(cal, 'recent')]);
    const tombstones = await inSecond((tx) => changesSince(tx, [cal], start, 10));
    const changedAt = (uid: string) => tombstones.rows.find((row) => row.uid === uid)?.changedAt.getTime() ?? 0;
    // Between the two deletions, by the database's clock.
    const cutoff = new Date((changedAt('old') + changedAt('recent')) / 2);

    const { floor, purged } = await withControl((control) => purgeTombstones(control, cutoff));
    expect(floor).toBe(oldSeq ?? -1n);
    expect(purged).toBeGreaterThanOrEqual(1);
    const [setting] = await unsafeDb().select().from(systemSetting).where(eq(systemSetting.key, 'tombstone_floor'));
    expect(setting?.value).toBe(Number(floor));
    const left = await inSecond((tx) => changesSince(tx, [cal], start, 10));
    expect(left.rows.map((row) => row.uid).sort()).toEqual(['live', 'recent']);
  });

  test('NOTIFY reaches another connection only after commit, and never on rollback', async () => {
    const listener = postgres(testDatabaseUrl ?? '', { max: 1, onnotice: () => {} });
    const received: unknown[] = [];
    await listener.listen(CHANGES_CHANNEL, (payload) => received.push(JSON.parse(payload)));
    try {
      const sentAfter = Date.now();
      const { maxSeq } = await withTenant(tenant, async (tx) => {
        const result = await recordChanges(tx, [upsert(calendar, 'notified')]);
        await Bun.sleep(150);
        expect(received).toEqual([]);
        return result;
      });
      await eventually(() => received.length > 0);
      // `c` is the send time in epoch ms, from which listeners measure notify lag.
      expect(received).toEqual([{ t: tenant, s: String(maxSeq), c: expect.any(Number) }]);
      const [{ c }] = received as [{ c: number }];
      expect(c).toBeGreaterThanOrEqual(sentAfter - 1_000);
      expect(c).toBeLessThanOrEqual(Date.now() + 1_000);

      const rollback = withTenant(tenant, async (tx) => {
        await recordChanges(tx, [upsert(calendar, 'rolled-back')]);
        throw new Error('rollback');
      });
      await expect(rollback).rejects.toThrow('rollback');
      await Bun.sleep(200);
      expect(received).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });
});
