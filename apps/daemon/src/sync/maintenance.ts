/**
 * Maintenance jobs: tenantless `sync_target` rows of kind `maintenance`, keyed by a fixed
 * `target_id`, so the scheduler runs each on one replica at a time.
 *
 * - `purge-tombstones`, daily: `purgeTombstones` from the change log.
 * - `purge-hosted-calendars`, daily: permanently removes hosted calendars deleted over 30 days ago.
 * - `renormalize`, at every boot: rows normalised by an older normaliser version are marked dirty
 *   in batches. Connected calendars wake their `events` targets; hosted calendars rebuild directly.
 *   Marking dirty is safe without a lease: it only ever adds work, and the runner (fenced) clears
 *   `dirty` only on the groups it actually normalised.
 */
import { normalizers, SOURCE_FORMATS } from '@supercal/core';
import { calendarAccount, sourceCalendar, newId, organization, purgeTombstones, sourceObject, syncTarget, withControl, withTenant, type SourceCalendarId, type SyncTargetId, type TenantId } from '@supercal/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { rebuildHostedCalendar, lockCalendarWrites } from '../hosted/objects.ts';
import type { Logger } from '../log.ts';
import { StopTargetError, wakeTargets, type Job, type JobResult } from './scheduler.ts';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 1000;

export const MAINTENANCE_JOBS = ['purge-tombstones', 'renormalize', 'purge-hosted-calendars'] as const;
type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];
const isMaintenanceJob = (target: string): target is MaintenanceJob => MAINTENANCE_JOBS.some((name) => name === target);

const ofJob = (name: MaintenanceJob) => and(sql`${syncTarget.kind} = 'maintenance'`, eq(syncTarget.targetId, name));

/** Registers the maintenance targets (idempotent) and makes `renormalize` due now. Called at worker boot. */
export async function registerMaintenance(): Promise<void> {
  await withControl(async (tx) => {
    // Raw SQL: Drizzle would list every column, and supercal_control may insert only these.
    const rows = MAINTENANCE_JOBS.map((name) => sql`(${newId('tgt')}, 'maintenance', ${name})`);
    await tx.execute(sql`insert into ${syncTarget} (id, kind, target_id) values ${sql.join(rows, sql`, `)} on conflict do nothing`);
    await tx.update(syncTarget).set({ nextRunAt: sql`clock_timestamp()` }).where(ofJob('renormalize'));
  });
}

/** Rows written by an older version of their format's normaliser. */
const stale = sql.join(
  SOURCE_FORMATS.flatMap((format) => {
    const current = normalizers[format];
    return current ? [and(eq(sourceObject.format, format), lt(sourceObject.normalizerVersion, current.version))] : [];
  }),
  sql` or `,
);

/** Marks one tenant's stale rows dirty, `BATCH` at a time, waking each batch's targets. Returns how many rows. */
async function renormalizeTenant(tenantId: TenantId): Promise<number> {
  let total = 0;
  for (let marked = BATCH; marked === BATCH; ) {
    const batch = await withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ source_calendar_id: SourceCalendarId }>(sql`
        update ${sourceObject} set dirty = true
        where (source_calendar_id, provider_object_id) in (
          select source_calendar_id, provider_object_id from ${sourceObject} where not dirty and (${stale}) limit ${BATCH})
        returning source_calendar_id`);
      const calendars = [...new Set(rows.map((r) => r.source_calendar_id))];
      const hosted = calendars.length ? await tx.select({ id: sourceCalendar.id }).from(sourceCalendar).innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId)).where(and(inArray(sourceCalendar.id, calendars), eq(calendarAccount.provider, 'hosted'))) : [];
      const connected = calendars.filter((id) => !hosted.some((calendar) => calendar.id === id));
      if (connected.length > 0) {
        const targets = await tx
          .select({ id: syncTarget.id })
          .from(syncTarget)
          .where(and(eq(syncTarget.kind, 'events'), inArray(syncTarget.targetId, connected)));
        await wakeTargets(tx, targets.map((t): SyncTargetId => t.id));
      }
      return { marked: rows.length, hosted };
    });
    marked = batch.marked;
    for (const calendar of batch.hosted) await withTenant(tenantId, (tx) => rebuildHostedCalendar(tx, calendar.id));
    total += marked;
  }
  const pending = await withTenant(tenantId, (tx) => tx.selectDistinct({ id: sourceCalendar.id }).from(sourceCalendar)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
    .innerJoin(sourceObject, eq(sourceObject.sourceCalendarId, sourceCalendar.id))
    .where(and(eq(calendarAccount.provider, 'hosted'), eq(sourceObject.dirty, true))));
  for (const calendar of pending) await withTenant(tenantId, (tx) => rebuildHostedCalendar(tx, calendar.id));
  return total;
}

/** Runs one maintenance job. */
export async function runMaintenance(job: Job, log: Logger): Promise<JobResult> {
  if (!isMaintenanceJob(job.target)) throw new StopTargetError(`unknown maintenance job ${job.target}`);
  if (job.target === 'purge-tombstones') {
    const { floor, purged } = await withControl((tx) => purgeTombstones(tx));
    log.info('tombstones purged', { floor: floor.toString(), purged });
    return { nextRunInMs: DAY };
  }
  const tenants = await withControl((tx) => tx.select({ id: organization.id }).from(organization));
  if (job.target === 'purge-hosted-calendars') {
    for (const { id } of tenants) await withTenant(id as TenantId, async (tx) => {
      const expired = await tx.select({ id: sourceCalendar.id }).from(sourceCalendar).innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId)).where(and(eq(calendarAccount.provider, 'hosted'), lt(sourceCalendar.goneAt, sql`now() - interval '30 days'`)));
      for (const calendar of expired) {
        await lockCalendarWrites(tx, calendar.id);
        await tx.delete(sourceCalendar).where(and(eq(sourceCalendar.id, calendar.id), lt(sourceCalendar.goneAt, sql`now() - interval '30 days'`)));
      }
    });
    return { nextRunInMs: DAY };
  }
  let marked = 0;
  for (const { id } of tenants) marked += await renormalizeTenant(id as TenantId);
  if (marked > 0) log.info('objects queued for re-normalisation', { marked });
  return { nextRunInMs: Infinity };
}
