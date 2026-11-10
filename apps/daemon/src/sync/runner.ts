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
 *    publishes nothing) become deletes, and only real revision or span changes reach `recordChanges`. Then the cursor is stored.
 */
import { normalizers, type Normalizer } from '@supercal/core';
import {
  calendarAccount,
  graphOccurrence,
  pushLease,
  recordChanges,
  sourceCalendar,
  sourceObject,
  syncTarget,
  withTenant,
  type CalendarAccount,
  type ResourceChange,
  type SourceCalendar,
  type SourceCalendarId,
  type TenantTx,
} from '@supercal/db';
import { AuthFailedError, ProviderThrottledError, ProviderUnavailableError, type Provider, type SourceCalendarRef, type SyncEnd } from '@supercal/providers';
import { and, count, eq, gt, lt, notExists, or, sql } from 'drizzle-orm';
import { applyRawObjects, markGroupsDirty } from './objects.ts';
import { normalizeDirtyGroups } from './changes.ts';
import type { Logger } from '../log.ts';
import { metrics } from '../ops/metrics.ts';
import { MAX_OBJECTS_PER_CALENDAR } from '../hosted/objects.ts';
import { withAccount, type SyncDeps, type TenantJob } from './context.ts';
import { LeaseLostError, nextPollMs, StopTargetError, type JobResult } from './scheduler.ts';

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

  return normalizeDirtyGroups(tx, calendar, normalizer, log, { objectNames: false });
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
        const total = await fenced(job, async (tx) => {
          await applyRawObjects(tx, { tenantId: job.tenantId, calendar, format: adapter.format, seenGeneration: job.version }, item);
          const [row] = await tx.select({ count: count() }).from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
          return row?.count ?? 0;
        });
        if (total > MAX_OBJECTS_PER_CALENDAR) throw new StopTargetError('This calendar has more than 50,000 events');
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
