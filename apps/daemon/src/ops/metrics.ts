/**
 * The daemon's metrics, one process-wide registry served at `/metrics`. Call sites import `metrics`
 * and record directly:
 *
 *   metrics.leaseLost.inc({});
 *   metrics.syncDuration.observe({ provider, outcome: 'ok' }, seconds);
 *
 * `supercal_sink_writes_total` is registered ahead of the sink runner, so dashboards can rely on it.
 */
import { pushLease, withControl, type PushTarget } from '@supercal/db';
import { count, sql } from 'drizzle-orm';
import { createRegistry } from './registry.ts';

export const registry = createRegistry();

/** Seconds, from a fast poll to a slow full resync. */
const SYNC_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
/** Seconds between a change's commit and its notification arriving. */
const LAG_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export const metrics = {
  syncDuration: registry.histogram('supercal_sync_duration_seconds', 'Duration of events sync runs, by provider and outcome (ok or error).', SYNC_BUCKETS, ['provider', 'outcome']),
  syncErrors: registry.counter('supercal_sync_errors_total', 'Failed events sync runs, by provider and error kind.', ['provider', 'kind']),
  leaseLost: registry.counter('supercal_lease_lost_total', 'Sync jobs stopped because another worker took over their lease.'),
  resourceChanges: registry.counter('supercal_resource_changes_total', 'Resource changes recorded in the change log by sync runs.'),
  notifyLag: registry.histogram('supercal_notify_lag_seconds', 'Time from a change commit to its notification reaching this process.', LAG_BUCKETS),
  feedRequests: registry.counter('supercal_feed_requests_total', 'Feed requests, by kind (caldav or ics) and HTTP status.', ['kind', 'status']),
  icsCacheHits: registry.counter('supercal_ics_cache_hits_total', 'ICS bodies served from the in-process cache.'),
  icsCacheMisses: registry.counter('supercal_ics_cache_misses_total', 'ICS bodies rendered because the cache had no copy.'),
  pushLeases: registry.gauge('supercal_push_leases', 'Push subscriptions in the database, by provider and state (active or expired).', ['provider', 'state']),
  sinkWrites: registry.counter('supercal_sink_writes_total', 'Events written to sink calendars, by outcome.', ['outcome']),
};

/** A lease's provider follows from its target; `supercal_control` may not read `calendar_account`. */
const LEASE_PROVIDER = { account: 'microsoft', calendar: 'google', 'calendar-list': 'google' } as const satisfies Record<PushTarget, string>;

// Push leases live in the database, so every replica reports the same install-wide numbers.
registry.collect(async () => {
  const rows = await withControl((tx) =>
    tx
      .select({ target: pushLease.target, active: sql<boolean>`${pushLease.expiresAt} > now()`, leases: count() })
      .from(pushLease)
      .groupBy(pushLease.target, sql`2`),
  );
  metrics.pushLeases.reset();
  for (const row of rows) metrics.pushLeases.inc({ provider: LEASE_PROVIDER[row.target], state: row.active ? 'active' : 'expired' }, row.leases);
});
