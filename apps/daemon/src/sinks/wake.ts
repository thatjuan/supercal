/**
 * Sink wake-ups (architecture §10). A bus `change` (new resource seqs) or `feed.changed` (a
 * publication edit, which may bump its epoch) for a tenant wakes that tenant's sink targets that
 * are behind: a source of their publication has a resource past the cursor's seq, or the epoch
 * moved. Notifications are hints; the 10-minute safety poll catches anything missed.
 *
 *   const stop = watchSinks(bus, log);
 */
import { withTenant, type SyncTargetId, type TenantId } from '@supercal/db';
import { sql } from 'drizzle-orm';
import type { Bus } from '../bus.ts';
import type { Logger } from '../log.ts';
import { wakeTargets } from '../sync/scheduler.ts';

/** Wakes the tenant's active sink targets whose publication has changes they have not applied. */
export async function wakeSinks(tenantId: TenantId): Promise<SyncTargetId[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ id: SyncTargetId }>(sql`
      select t.id from sync_target t
      join sink s on s.id = t.target_id
      join publication p on p.id = s.publication_id
      where t.kind = 'sink' and s.status = 'active' and (
        t.cursor is null
        or (t.cursor ->> 'epoch') is distinct from p.epoch::text
        or exists (
          select 1 from publication_source ps
          join resource r on r.source_calendar_id = ps.source_calendar_id
          where ps.publication_id = p.id and r.seq > (t.cursor ->> 'seq')::bigint))`);
    const ids = rows.map((r) => r.id);
    await wakeTargets(tx, ids);
    return ids;
  });
}

/** Subscribes to the bus and wakes sinks per tenant, coalescing bursts of notifications. Returns the unsubscribe function. */
export function watchSinks(bus: Bus, log: Logger, { delayMs = 200 } = {}): () => void {
  const pending = new Set<TenantId>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const tenants = [...pending];
    pending.clear();
    for (const tenantId of tenants) wakeSinks(tenantId).catch((error: unknown) => log.warn('waking sinks failed', { tenantId, error }));
  };
  const schedule = (tenantId: TenantId) => {
    pending.add(tenantId);
    timer ??= setTimeout(flush, delayMs);
  };
  const off = [bus.on('change', ({ tenantId }) => schedule(tenantId)), bus.on('event', ({ tenantId, event }) => event.type === 'feed.changed' && schedule(tenantId))];
  return () => {
    off.forEach((stop) => stop());
    if (timer) clearTimeout(timer);
  };
}
