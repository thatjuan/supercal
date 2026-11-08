/**
 * Maintenance jobs: tenantless `sync_target` rows of kind `maintenance`, keyed by a fixed
 * `target_id`, so the scheduler runs each on one replica at a time.
 *
 * - `purge-tombstones`, daily: `purgeTombstones` from the change log.
 * - `renormalize`, at every boot: rows normalised by an older normaliser version are marked dirty
 *   in batches and their `events` targets woken, so the ordinary runner rebuilds their resources.
 *   Marking dirty is safe without a lease: it only ever adds work, and the runner (fenced) clears
 *   `dirty` only on the groups it actually normalised.
 */
import { normalizers, SOURCE_FORMATS } from '@supercal/core';
import { newId, organization, purgeTombstones, sourceObject, syncTarget, withControl, withTenant, type SyncTargetId, type TenantId } from '@supercal/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Logger } from '../log.ts';
import { StopTargetError, wakeTargets, type Job, type JobResult } from './scheduler.ts';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 1000;

export const MAINTENANCE_JOBS = ['purge-tombstones', 'renormalize'] as const;
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
    marked = await withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ source_calendar_id: string }>(sql`
        update ${sourceObject} set dirty = true
        where (source_calendar_id, provider_object_id) in (
          select source_calendar_id, provider_object_id from ${sourceObject} where not dirty and (${stale}) limit ${BATCH})
        returning source_calendar_id`);
      const calendars = [...new Set(rows.map((r) => r.source_calendar_id))];
      if (calendars.length > 0) {
        const targets = await tx
          .select({ id: syncTarget.id })
          .from(syncTarget)
          .where(and(eq(syncTarget.kind, 'events'), inArray(syncTarget.targetId, calendars)));
        await wakeTargets(tx, targets.map((t): SyncTargetId => t.id));
      }
      return rows.length;
    });
    total += marked;
  }
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
  let marked = 0;
  for (const { id } of tenants) marked += await renormalizeTenant(id as TenantId);
  if (marked > 0) log.info('objects queued for re-normalisation', { marked });
  return { nextRunInMs: Infinity };
}
