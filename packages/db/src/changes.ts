/**
 * The change log (architecture §6). `resource` is both the current state and the log: every write
 * stamps the row with a fresh `seq` from `change_seq`, and deletions stay behind as tombstones.
 * `recordChanges` is the only code that writes `resource`; the read queries below are how CalDAV,
 * ICS, SSE and sinks read it. Each read is one statement, so a token and its rows share a snapshot.
 */
import type { Completeness, EventResource } from '@supercal/core';
import { and, asc, eq, gt, inArray, max, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { SourceCalendarId } from './ids.ts';
import { resource, systemSetting, type Resource } from './schema/index.ts';
import type { ControlTx, TenantTx } from './tx.ts';

/** The NOTIFY channel `recordChanges` signals on, with payload `{"t":"<tenantId>","s":"<maxSeq>"}`. */
export const CHANGES_CHANNEL = 'supercal_changes';

/** Advisory lock namespace for per-tenant change serialisation (`pg_advisory_xact_lock(ns, key)`). */
const CHANGE_LOCK_NAMESPACE = 1937011297;

/** Rows per statement, keeping every query well under Postgres's 65,535 bind parameters. */
const BATCH = 1000;

export type ResourceChange =
  | {
      op: 'upsert';
      sourceCalendarId: SourceCalendarId;
      uid: string;
      resource: EventResource;
      revision: string;
      sequence: number | null;
      lastModified: Date | null;
      organizer: string | null;
      span: { start: Date; end: Date | 'infinity' };
      completeness: Completeness;
    }
  | { op: 'delete'; sourceCalendarId: SourceCalendarId; uid: string };

/** A current resource. */
export type LiveResource = Resource & { deleted: false; data: EventResource };
/** A deleted resource, kept so incremental readers learn of the deletion until it is purged. */
export type Tombstone = Resource & { deleted: true; data: null };
/** A row of the change log: narrow on `deleted`. */
export type ResourceRow = LiveResource | Tombstone;

const tenantSetting = sql`current_setting('app.tenant_id')`;
const excluded = (column: PgColumn) => sql.raw(`excluded."${column.name}"`);
const keyOf = (change: { sourceCalendarId: string; uid: string }) => `${change.sourceCalendarId}\0${change.uid}`;
const keysIn = (changes: ResourceChange[]) =>
  sql`(${resource.sourceCalendarId}, ${resource.uid}) in (${sql.join(
    changes.map((c) => sql`(${c.sourceCalendarId}, ${c.uid})`),
    sql`, `,
  )})`;

function* batches<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += BATCH) yield items.slice(i, i + BATCH);
}

/**
 * Applies `changes` to `resource` and signals `supercal_changes`. Call it as the **last** work in
 * the caller's transaction, after all fetching and normalising: it takes the tenant's advisory
 * lock, which is held until commit so the tenant's seqs commit in order (without it, concurrent
 * readers skip changes). Upserts whose revision matches the stored row and deletes of absent or
 * tombstoned rows are dropped; when nothing remains, no lock or seq is taken and `maxSeq` is null.
 * `changed` counts the changes that remained. The notification carries `c`, the epoch ms at which
 * it was sent (moments before commit), from which listeners measure notify lag.
 */
export async function recordChanges(tx: TenantTx, changes: ResourceChange[]): Promise<{ maxSeq: bigint | null; changed: number }> {
  const real = await withoutNoops(tx, [...new Map(changes.map((c) => [keyOf(c), c])).values()]);
  if (real.length === 0) return { maxSeq: null, changed: 0 };

  await tx.execute(sql`select pg_advisory_xact_lock(${CHANGE_LOCK_NAMESPACE}, hashtext(${tenantSetting}))`);
  let maxSeq = 0n;
  const bump = (rows: { seq: bigint }[]) => rows.forEach(({ seq }) => (maxSeq = seq > maxSeq ? seq : maxSeq));
  const stamp = { seq: sql`nextval('change_seq')`, changedAt: sql`clock_timestamp()` };

  const upserts = real.filter((c) => c.op === 'upsert');
  for (const batch of batches(upserts)) {
    const rows = batch.map((c) => ({
      tenantId: tenantSetting,
      sourceCalendarId: c.sourceCalendarId,
      uid: c.uid,
      data: c.resource,
      revision: c.revision,
      sequence: c.sequence ?? 0,
      lastModified: c.lastModified,
      organizer: c.organizer,
      span: c.span,
      completeness: c.completeness === 'complete' ? ('complete' as const) : ('incomplete' as const),
      completenessReason: c.completeness === 'complete' ? null : c.completeness.incomplete,
      deleted: false,
      ...stamp,
    }));
    const set = Object.fromEntries(
      (['data', 'revision', 'sequence', 'lastModified', 'organizer', 'span', 'completeness', 'completenessReason', 'deleted'] as const).map(
        (key) => [key, excluded(resource[key])],
      ),
    );
    bump(
      await tx
        .insert(resource)
        .values(rows)
        .onConflictDoUpdate({ target: [resource.sourceCalendarId, resource.uid], set: { ...set, ...stamp } })
        .returning({ seq: resource.seq }),
    );
  }

  for (const batch of batches(real.filter((c) => c.op === 'delete')))
    bump(
      await tx
        .update(resource)
        .set({ deleted: true, data: null, ...stamp })
        .where(and(eq(resource.deleted, false), keysIn(batch)))
        .returning({ seq: resource.seq }),
    );

  await tx.execute(
    sql`select pg_notify(${CHANGES_CHANNEL}, json_build_object('t', ${tenantSetting}, 's', ${maxSeq.toString()}::text, 'c', floor(extract(epoch from clock_timestamp()) * 1000))::text)`,
  );
  return { maxSeq, changed: real.length };
}

/** Drops upserts that would not change the stored revision, and deletes with nothing live to delete. */
async function withoutNoops(tx: TenantTx, changes: ResourceChange[]): Promise<ResourceChange[]> {
  const stored = new Map<string, { revision: string; deleted: boolean }>();
  for (const batch of batches(changes)) {
    const rows = await tx
      .select({ sourceCalendarId: resource.sourceCalendarId, uid: resource.uid, revision: resource.revision, deleted: resource.deleted })
      .from(resource)
      .where(keysIn(batch));
    for (const row of rows) stored.set(keyOf(row), row);
  }
  return changes.filter((c) => {
    const row = stored.get(keyOf(c));
    return c.op === 'upsert' ? !row || row.deleted || row.revision !== c.revision : !!row && !row.deleted;
  });
}

const inSources = (ids: readonly SourceCalendarId[]) => inArray(resource.sourceCalendarId, [...ids]);

/** Cheap aggregate for ctag, sync-token, ETag and Last-Modified: the newest seq (0 when empty) and change time. */
export async function publicationState(
  tx: TenantTx,
  sourceCalendarIds: readonly SourceCalendarId[],
): Promise<{ maxSeq: bigint; lastChangedAt: Date | null }> {
  const [state] = await tx
    .select({ maxSeq: max(resource.seq), lastChangedAt: max(resource.changedAt) })
    .from(resource)
    .where(inSources(sourceCalendarIds));
  return { maxSeq: state?.maxSeq ?? 0n, lastChangedAt: state?.lastChangedAt ?? null };
}

/**
 * Rows (tombstones included) with `seq > afterSeq`, oldest first, at most `limit`. `maxSeq` is the
 * position to resume from: the last row's seq when `hasMore`, else the sources' newest seq. Rows
 * and `maxSeq` come from one statement, because a separate `max(seq)` query can skip changes.
 */
export async function changesSince(
  tx: TenantTx,
  sourceCalendarIds: readonly SourceCalendarId[],
  afterSeq: bigint,
  limit: number,
): Promise<{ rows: ResourceRow[]; maxSeq: bigint; hasMore: boolean }> {
  const page = tx
    .$with('page')
    .as(
      tx
        .select()
        .from(resource)
        .where(and(inSources(sourceCalendarIds), gt(resource.seq, afterSeq)))
        .orderBy(asc(resource.seq))
        .limit(limit + 1),
    );
  const top = tx.$with('top').as(tx.select({ maxSeq: max(resource.seq).as('max_seq') }).from(resource).where(inSources(sourceCalendarIds)));
  const result = await tx.with(page, top).select().from(top).leftJoin(page, sql`true`).orderBy(asc(page.seq));

  const all = result.flatMap((r) => (r.page ? [r.page as ResourceRow] : []));
  const rows = all.slice(0, limit);
  const hasMore = all.length > limit;
  const newest = result[0]?.top.maxSeq ?? 0n;
  const last = rows.at(-1)?.seq;
  return { rows, hasMore, maxSeq: hasMore && last !== undefined ? last : newest > afterSeq ? newest : afterSeq };
}

/** Live rows, optionally only those whose span overlaps `[range.from, range.to)` (coarse: may include extras). */
export async function resourcesIn(
  tx: TenantTx,
  sourceCalendarIds: readonly SourceCalendarId[],
  range?: { from: Date; to: Date },
): Promise<LiveResource[]> {
  const overlaps: SQL | undefined = range && sql`${resource.span} && tstzrange(${range.from.toISOString()}::timestamptz, ${range.to.toISOString()}::timestamptz)`;
  const rows = await tx
    .select()
    .from(resource)
    .where(and(inSources(sourceCalendarIds), eq(resource.deleted, false), overlaps));
  return rows as LiveResource[];
}

/** Live rows for `uids` (every copy across the given sources). */
export async function resourcesByUids(
  tx: TenantTx,
  sourceCalendarIds: readonly SourceCalendarId[],
  uids: readonly string[],
): Promise<LiveResource[]> {
  const rows = await tx
    .select()
    .from(resource)
    .where(and(inSources(sourceCalendarIds), eq(resource.deleted, false), inArray(resource.uid, [...uids])));
  return rows as LiveResource[];
}

const TOMBSTONE_FLOOR = 'tombstone_floor';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The seq at or below which tombstones may be gone: positions below it cannot be replayed. */
export async function tombstoneFloor(tx: TenantTx | ControlTx): Promise<bigint> {
  const [row] = await tx
    .select({ floor: sql<string>`(${systemSetting.value} #>> '{}')` })
    .from(systemSetting)
    .where(eq(systemSetting.key, TOMBSTONE_FLOOR));
  if (!row) throw new Error(`system_setting ${TOMBSTONE_FLOOR} is missing`);
  return BigInt(row.floor);
}

/**
 * Deletes tombstones last changed before `olderThan` (default 30 days ago), across tenants. First
 * raises `system_setting.tombstone_floor` to the newest such tombstone's seq (never lowering it),
 * then deletes every tombstone at or below the floor; sync tokens below the floor are rejected.
 * Allocates no seq, so it takes no tenant lock. Returns the floor and how many rows were purged.
 */
export async function purgeTombstones(
  control: ControlTx,
  olderThan = new Date(Date.now() - TOMBSTONE_TTL_MS),
): Promise<{ floor: bigint; purged: number }> {
  const oldest = control
    .select({ seq: max(resource.seq) })
    .from(resource)
    .where(and(eq(resource.deleted, true), sql`${resource.changedAt} < ${olderThan.toISOString()}::timestamptz`));
  const current = sql`(${systemSetting.value} #>> '{}')::bigint`;
  const [setting] = await control
    .update(systemSetting)
    .set({ value: sql`to_jsonb(greatest(${current}, (${oldest})))` })
    .where(eq(systemSetting.key, TOMBSTONE_FLOOR))
    .returning({ floor: sql<string>`${current}::text` });
  if (!setting) throw new Error(`system_setting ${TOMBSTONE_FLOOR} is missing`);

  const floor = BigInt(setting.floor);
  const purged = await control
    .delete(resource)
    .where(and(eq(resource.deleted, true), sql`${resource.seq} <= ${floor.toString()}::bigint`))
    .returning({ seq: resource.seq });
  return { floor, purged: purged.length };
}
