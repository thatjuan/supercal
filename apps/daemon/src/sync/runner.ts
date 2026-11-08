/**
 * The sync runner for `events` targets (architecture §8): raw pages → `source_object`, then on
 * `end` the dirty groups → normalised resources → `recordChanges`. Every transaction that writes
 * `source_object`, `resource`, `graph_occurrence` or a cursor goes through `fenced`, so a worker
 * whose lease was taken over commits nothing.
 *
 * 1. Each page is one short fenced transaction: upserts (dirty, `seen_generation = lease_version`),
 *    touches (only `seen_generation`), deletes and occurrence records (`graph_occurrence`). Nothing
 *    is normalised yet, so a failed later page leaves the cursor and every resource as they were;
 *    the next run replays.
 * 2. `end` is one fenced transaction: a snapshot deletes the objects it did not see (and the
 *    occurrence records of masters that went with them), every dirty
 *    group is normalised from all its objects, resources whose group lost every object (or now
 *    publishes nothing) become deletes, and only real revision changes reach `recordChanges`. Then the cursor is stored.
 */
import { lastModified, normalizers, organizer, revisionOf, sequence, spanOf, type Completeness, type EventResource, type Normalizer } from '@supercal/core';
import {
  calendarAccount,
  graphOccurrence,
  pushLease,
  recordChanges,
  resource,
  sourceCalendar,
  sourceObject,
  syncTarget,
  withTenant,
  type CalendarAccount,
  type ResourceChange,
  type SourceCalendar,
  type SourceCalendarId,
  type SourceFormat,
  type Span,
  type TenantTx,
} from '@supercal/db';
import { AuthFailedError, ProviderThrottledError, ProviderUnavailableError, type Provider, type SourceCalendarRef, type SyncEnd, type SyncPage } from '@supercal/providers';
import { and, eq, gt, inArray, lt, notExists, or, sql } from 'drizzle-orm';
import type { Logger } from '../log.ts';
import { metrics } from '../ops/metrics.ts';
import { withAccount, type SyncDeps, type TenantJob } from './context.ts';
import { LeaseLostError, nextPollMs, StopTargetError, type JobResult } from './scheduler.ts';

/** Rows per statement, well under Postgres's bind-parameter limit. */
const BATCH = 500;

function* chunks<T>(items: readonly T[], size = BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Runs `fn` in a tenant transaction that first locks the job's target row and checks the lease is
 * still this job's; otherwise it throws `LeaseLostError` and nothing commits. `clock_timestamp()`,
 * because `now()` is frozen at transaction start.
 */
export function fenced<T>(job: TenantJob, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(job.tenantId, async (tx) => {
    const held = await tx.execute(sql`
      select 1 from ${syncTarget}
      where id = ${job.id} and lease_owner = ${job.owner} and lease_version = ${job.version} and lease_until > clock_timestamp()
      for update`);
    if (held.length === 0) throw new LeaseLostError(`lease ${job.version} on ${job.id} is gone`);
    return fn(tx);
  });
}

/** Marks every object of `groups` dirty, after one of their objects moved or went away. */
async function markGroupsDirty(tx: TenantTx, calendarId: SourceCalendarId, groups: readonly string[]) {
  for (const batch of chunks([...new Set(groups)]))
    await tx.update(sourceObject).set({ dirty: true }).where(and(eq(sourceObject.sourceCalendarId, calendarId), inArray(sourceObject.groupUid, batch)));
}

/** Writes one page of raw objects, stamping each with the lease version as its `seen_generation` for the snapshot sweep. */
async function writePage(tx: TenantTx, job: TenantJob, calendar: SourceCalendar, format: SourceFormat, page: SyncPage) {
  const where = (ids: string[]) => and(eq(sourceObject.sourceCalendarId, calendar.id), inArray(sourceObject.providerObjectId, ids));
  const touched = page.upserts.filter((o) => o.payload === null).map((o) => o.id);
  for (const batch of chunks(touched)) await tx.update(sourceObject).set({ seenGeneration: job.version }).where(where(batch));

  for (const batch of chunks(page.upserts.filter((o) => o.payload !== null))) {
    // An object that moved to another group leaves its old group to rebuild.
    const moved = await tx
      .select({ groupUid: sourceObject.groupUid })
      .from(sourceObject)
      .where(and(where(batch.map((o) => o.id)), or(...batch.map((o) => and(eq(sourceObject.providerObjectId, o.id), sql`${sourceObject.groupUid} <> ${o.groupUid}`)))));
    await markGroupsDirty(tx, calendar.id, moved.map((m) => m.groupUid));
    await tx
      .insert(sourceObject)
      .values(
        batch.map((o) => ({
          tenantId: job.tenantId,
          sourceCalendarId: calendar.id,
          providerObjectId: o.id,
          format,
          payload: typeof o.payload === 'string' ? o.payload : JSON.stringify(o.payload),
          etag: o.etag,
          groupUid: o.groupUid,
          originalStart: o.originalStart ?? null,
          seenGeneration: job.version,
          dirty: true,
        })),
      )
      .onConflictDoUpdate({
        target: [sourceObject.sourceCalendarId, sourceObject.providerObjectId],
        set: {
          format: sql`excluded.format`,
          payload: sql`excluded.payload`,
          etag: sql`excluded.etag`,
          groupUid: sql`excluded.group_uid`,
          originalStart: sql`excluded.original_start`,
          seenGeneration: sql`excluded.seen_generation`,
          // An unchanged payload in an unchanged group needs no re-normalisation.
          dirty: sql`${sourceObject.dirty} or ${sourceObject.payload} is distinct from excluded.payload or ${sourceObject.groupUid} is distinct from excluded.group_uid`,
        },
      });
  }

  for (const batch of chunks(page.deletes)) {
    const gone = await tx.delete(sourceObject).where(where(batch)).returning({ groupUid: sourceObject.groupUid });
    await markGroupsDirty(tx, calendar.id, gone.map((g) => g.groupUid));
  }

  for (const batch of chunks(page.occurrences ?? []))
    await tx
      .insert(graphOccurrence)
      .values(batch.map((o) => ({ tenantId: job.tenantId, sourceCalendarId: calendar.id, ...o })))
      .onConflictDoUpdate({ target: [graphOccurrence.sourceCalendarId, graphOccurrence.masterId, graphOccurrence.occurrenceId], set: { originalStart: sql`excluded.original_start` } });
}

/** The recorded occurrences of a master (id → original start), for `SourceCalendarRef.occurrences`. */
const occurrencesOf = (job: TenantJob, calendarId: SourceCalendarId) => async (masterId: string) => {
  const rows = await withTenant(job.tenantId, (tx) =>
    tx
      .select({ occurrenceId: graphOccurrence.occurrenceId, originalStart: graphOccurrence.originalStart })
      .from(graphOccurrence)
      .where(and(eq(graphOccurrence.sourceCalendarId, calendarId), eq(graphOccurrence.masterId, masterId))),
  );
  return new Map(rows.map((r) => [r.occurrenceId, r.originalStart]));
};

type Upsert = Extract<ResourceChange, { op: 'upsert' }>;

const spanDates = ({ start, end }: ReturnType<typeof spanOf>): Span => ({
  start: new Date(start.epochMilliseconds),
  end: end === 'infinity' ? 'infinity' : new Date(end.epochMilliseconds),
});

/** The `ResourceChange` for a normalised group. Without `span`, computes it, throwing when the resource has no usable timing. */
function upsertOf(calendar: SourceCalendar, uid: string, data: EventResource, completeness: Completeness, span?: Span): Upsert {
  const main = data.master ?? data.overrides[0] ?? null;
  const modified = main && lastModified(main);
  return {
    op: 'upsert',
    sourceCalendarId: calendar.id,
    uid,
    resource: data,
    // Completeness is part of the revision, so marking a resource incomplete is a change.
    revision: completeness === 'complete' ? revisionOf(data) : `${revisionOf(data)}.incomplete`,
    sequence: main && sequence(main),
    lastModified: modified ? new Date(modified.epochMilliseconds) : null,
    organizer: (main && organizer(main)?.address) ?? null,
    span: span ?? spanDates(spanOf(data, calendar.timezone ?? 'UTC')),
    completeness,
  };
}

/**
 * The `end` transaction's work after the fence, up to (not including) `recordChanges`: the
 * snapshot sweep, normalisation of dirty groups and orphan deletes. Returns the real changes. A group
 * that fails to normalise keeps its last good data, marked incomplete, and never stops the rest.
 */
async function resourceChanges(tx: TenantTx, job: TenantJob, calendar: SourceCalendar, normalizer: Normalizer, end: SyncEnd<unknown>, log: Logger): Promise<ResourceChange[]> {
  const ofCalendar = eq(sourceObject.sourceCalendarId, calendar.id);
  if (end.mode === 'snapshot') {
    const unseen = await tx.delete(sourceObject).where(and(ofCalendar, lt(sourceObject.seenGeneration, job.version))).returning({ groupUid: sourceObject.groupUid });
    await markGroupsDirty(tx, calendar.id, unseen.map((u) => u.groupUid));
    await tx
      .delete(graphOccurrence)
      .where(
        and(
          eq(graphOccurrence.sourceCalendarId, calendar.id),
          notExists(tx.select({ one: sql`1` }).from(sourceObject).where(and(ofCalendar, eq(sourceObject.providerObjectId, graphOccurrence.masterId)))),
        ),
      );
  }

  const changes: ResourceChange[] = [];
  const dirty = (await tx.selectDistinct({ groupUid: sourceObject.groupUid }).from(sourceObject).where(and(ofCalendar, eq(sourceObject.dirty, true)))).map((d) => d.groupUid);
  for (const groups of chunks(dirty)) {
    const objects = await tx.select().from(sourceObject).where(and(ofCalendar, inArray(sourceObject.groupUid, groups)));
    const stored = new Map(
      (await tx.select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), inArray(resource.uid, groups)))).map((r) => [r.uid, r]),
    );
    for (const uid of groups) {
      const members = objects.filter((o) => o.groupUid === uid);
      const before = stored.get(uid);
      let change: Upsert | null;
      try {
        const normalized = normalizer.normalize(members.map((o) => ({ id: o.providerObjectId, etag: o.etag ?? '', groupUid: uid, payload: o.payload })));
        if (!normalized) {
          // The group publishes nothing (e.g. only cancelled instances are left).
          if (before && !before.deleted) changes.push({ op: 'delete', sourceCalendarId: calendar.id, uid });
          continue;
        }
        change = upsertOf(calendar, uid, normalized.resource, normalized.completeness);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('normalisation failed', { calendarId: calendar.id, uid, providerObjectIds: members.map((o) => o.providerObjectId), error: reason });
        const last = stored.get(uid);
        change = last?.data && last.span ? upsertOf(calendar, uid, last.data, { incomplete: reason }, last.span) : null;
      }
      if (change && (!before || before.deleted || before.revision !== change.revision)) changes.push(change);
    }
    await tx
      .update(sourceObject)
      .set({ dirty: false, normalizerVersion: normalizer.version })
      .where(and(ofCalendar, inArray(sourceObject.groupUid, groups)));
  }

  // Resources whose group has no objects left (deleted, swept, or moved away).
  const orphans = await tx
    .select({ uid: resource.uid })
    .from(resource)
    .where(
      and(
        eq(resource.sourceCalendarId, calendar.id),
        eq(resource.deleted, false),
        notExists(tx.select({ one: sql`1` }).from(sourceObject).where(and(ofCalendar, eq(sourceObject.groupUid, resource.uid)))),
      ),
    );
  for (const { uid } of orphans) changes.push({ op: 'delete', sourceCalendarId: calendar.id, uid });
  return changes;
}

/** Whether a push subscription currently covers the calendar (per calendar, or mailbox-wide). */
async function pushActive(tx: TenantTx, calendar: SourceCalendar): Promise<boolean> {
  const [lease] = await tx
    .select({ id: pushLease.providerChannelId })
    .from(pushLease)
    .where(
      and(
        gt(pushLease.expiresAt, sql`clock_timestamp()`),
        or(and(eq(pushLease.target, 'calendar'), eq(pushLease.targetId, calendar.id)), and(eq(pushLease.target, 'account'), eq(pushLease.accountId, calendar.accountId))),
      ),
    )
    .limit(1);
  return lease !== undefined;
}

/** Loads the calendar, its account and the stored cursor for an `events` job. */
async function load(job: TenantJob): Promise<{ calendar: SourceCalendar; account: CalendarAccount; cursor: unknown }> {
  return withTenant(job.tenantId, async (tx) => {
    const [target] = await tx.select({ cursor: syncTarget.cursor }).from(syncTarget).where(eq(syncTarget.id, job.id));
    const [row] = await tx
      .select()
      .from(sourceCalendar)
      .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
      .where(eq(sourceCalendar.id, job.target as SourceCalendarId));
    if (!target || !row || row.source_calendar.state === 'gone') throw new StopTargetError('the calendar is gone');
    return { calendar: row.source_calendar, account: row.calendar_account, cursor: target.cursor };
  });
}

/** The `kind` label of `supercal_sync_errors_total` for a failed run. */
const errorKind = (error: unknown) =>
  error instanceof AuthFailedError
    ? 'auth'
    : error instanceof ProviderThrottledError
      ? 'throttled'
      : error instanceof ProviderUnavailableError
        ? 'unavailable'
        : error instanceof LeaseLostError
          ? 'lease_lost'
          : 'other';

/** Runs `sync` and records its duration and any failure in the sync metrics; runs aborted by shutdown are not recorded. */
async function measured<T>(provider: Provider, signal: AbortSignal, sync: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  try {
    const result = await sync();
    metrics.syncDuration.observe({ provider, outcome: 'ok' }, seconds());
    return result;
  } catch (error) {
    if (!signal.aborted || signal.reason instanceof LeaseLostError) {
      metrics.syncDuration.observe({ provider, outcome: 'error' }, seconds());
      metrics.syncErrors.inc({ provider, kind: errorKind(error) });
    }
    throw error;
  }
}

/** Runs one `events` job end to end and returns when to run it next. */
export async function runEvents(deps: SyncDeps, job: TenantJob, signal: AbortSignal): Promise<JobResult> {
  const { calendar, account, cursor } = await load(job);
  return withAccount(deps, job, account, signal, (adapter, ctx) => measured(account.provider, signal, async () => {
    const normalizer = normalizers[adapter.format];
    if (!normalizer) throw new Error(`no normaliser is registered for format ${adapter.format}`);
    const ref: SourceCalendarRef = { id: calendar.id, providerCalendarId: calendar.providerCalendarId, capabilities: calendar.capabilities, occurrences: occurrencesOf(job, calendar.id) };
    const log = deps.log.child({ calendarId: calendar.id });
    for await (const item of adapter.sync(ctx, ref, cursor)) {
      signal.throwIfAborted();
      if (item.kind === 'page') {
        await fenced(job, (tx) => writePage(tx, job, calendar, adapter.format, item));
        continue;
      }
      return fenced(job, async (tx) => {
        const changes = await resourceChanges(tx, job, calendar, normalizer, item, log);
        const now = new Date();
        const lastChangeAt = changes.length > 0 ? now.toISOString() : calendar.freshness.lastChangeAt;
        const push = await pushActive(tx, calendar);
        const nextRunInMs = nextPollMs({
          provider: account.provider,
          pushActive: push,
          hintMs: item.nextPollHint?.afterMs,
          sinceChangeMs: lastChangeAt ? now.getTime() - Date.parse(lastChangeAt) : null,
        });
        await tx
          .update(sourceCalendar)
          .set({ freshness: { lastSuccessAt: now.toISOString(), lastChangeAt, pushActive: push, expectedLatencyMs: nextRunInMs, stale: false } })
          .where(eq(sourceCalendar.id, calendar.id));
        await tx.update(syncTarget).set({ cursor: item.cursor }).where(eq(syncTarget.id, job.id));
        // Last: it takes the tenant's change lock until commit.
        const { changed } = await recordChanges(tx, changes);
        return { nextRunInMs, changed };
      }).then(({ nextRunInMs, changed }) => {
        metrics.resourceChanges.inc({}, changed);
        return { nextRunInMs };
      });
    }
    throw new Error('the adapter finished without an end item');
  }));
}
