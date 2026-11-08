/**
 * The sync engine (architecture §8): `createSyncDeps` wires adapters, secrets, the feeds service
 * and the transport; `syncHandlers` maps each `sync_target` kind to its job for `startScheduler`.
 * The API uses the same deps for the shared account flows in `accounts.ts`.
 */
import type { SecretBox, SyncKind } from '@supercal/db';
import { registry, type AdapterRegistry, type GuardedFetch } from '@supercal/providers';
import { createFeedService, type FeedService } from '../feeds/service.ts';
import type { Logger } from '../log.ts';
import type { SyncDeps, TenantJob } from './context.ts';
import { runDiscover } from './discovery.ts';
import { runMaintenance } from './maintenance.ts';
import { runPushRenew } from './push.ts';
import { runEvents } from './runner.ts';
import { createSlots, StopTargetError, type Job, type JobHandler } from './scheduler.ts';

/** Concurrent jobs per account (Graph allows 4 concurrent requests per mailbox). */
const PER_ACCOUNT = 2;
const HOUR = 60 * 60 * 1000;

export type { SyncDeps } from './context.ts';

export function createSyncDeps({
  secrets,
  fetch,
  log,
  adapters = registry,
  perAccount = PER_ACCOUNT,
  feeds = createFeedService(secrets),
  pushBaseUrl,
}: {
  secrets: SecretBox;
  feeds?: FeedService;
  fetch: GuardedFetch;
  log: Logger;
  adapters?: AdapterRegistry;
  perAccount?: number;
  pushBaseUrl?: string | null | undefined;
}): SyncDeps {
  return { adapters, secrets, fetch, log, feeds, pushBaseUrl: pushBaseUrl ?? null, accountSlot: createSlots(perAccount) };
}

const ofTenant = (job: Job): TenantJob => {
  if (job.tenantId === null) throw new StopTargetError(`${job.kind} target ${job.id} has no tenant`);
  return { ...job, tenantId: job.tenantId };
};

/** The job for every target kind. `sink` arrives with the sink providers. */
export function syncHandlers(deps: SyncDeps): Record<SyncKind, JobHandler> {
  const notYet: JobHandler = async (job) => {
    deps.log.warn('no handler for this target kind yet', { targetId: job.id, kind: job.kind });
    return { nextRunInMs: HOUR };
  };
  return {
    discover: (job, signal) => runDiscover(deps, ofTenant(job), signal),
    events: (job, signal) => runEvents(deps, ofTenant(job), signal),
    maintenance: (job) => runMaintenance(job, deps.log.child({ job: job.target })),
    push_renew: (job, signal) => runPushRenew(deps, ofTenant(job), signal),
    sink: notYet,
  };
}
