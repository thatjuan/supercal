/**
 * The sync engine (architecture §8): `createSyncDeps` wires adapters, secrets, the feeds service
 * and the transport; `syncHandlers` maps each `sync_target` kind to its job for `startScheduler`.
 * The API uses the same deps for the shared account flows in `accounts.ts`.
 */
import type { SecretBox, SyncKind } from '@supercal/db';
import { registry, type AdapterRegistry, type GoogleClientOptions, type GuardedFetch } from '@supercal/providers';
import { createFeedService, type FeedService } from '../feeds/service.ts';
import type { Logger } from '../log.ts';
import { createWriteBudget, type WriteBudget } from '../sinks/budget.ts';
import { createGoogleSinkClient, runGoogleSink } from '../sinks/google.ts';
import type { SyncDeps, TenantJob } from './context.ts';
import { runDiscover } from './discovery.ts';
import { runMaintenance } from './maintenance.ts';
import { runPushRenew } from './push.ts';
import { runEvents } from './runner.ts';
import { createSlots, StopTargetError, type Job, type JobHandler } from './scheduler.ts';

/** Concurrent jobs per account (Graph allows 4 concurrent requests per mailbox). */
const PER_ACCOUNT = 2;

export type { SyncDeps } from './context.ts';

export function createSyncDeps({
  secrets,
  fetch,
  log,
  adapters = registry,
  perAccount = PER_ACCOUNT,
  feeds = createFeedService(secrets),
  pushBaseUrl,
  google,
  sinkBudget = createWriteBudget(),
}: {
  secrets: SecretBox;
  feeds?: FeedService;
  fetch: GuardedFetch;
  log: Logger;
  adapters?: AdapterRegistry;
  perAccount?: number;
  pushBaseUrl?: string | null | undefined;
  /** The Google OAuth client (and, in tests, a mocked API base), which enables Google sinks. */
  google?: GoogleClientOptions | undefined;
  sinkBudget?: WriteBudget;
}): SyncDeps {
  return {
    adapters,
    secrets,
    fetch,
    log,
    feeds,
    pushBaseUrl: pushBaseUrl ?? null,
    accountSlot: createSlots(perAccount),
    googleSinks: google ? createGoogleSinkClient(google) : null,
    sinkBudget,
  };
}

const ofTenant = (job: Job): TenantJob => {
  if (job.tenantId === null) throw new StopTargetError(`${job.kind} target ${job.id} has no tenant`);
  return { ...job, tenantId: job.tenantId };
};

/** The job for every target kind. Google is the only sink provider (architecture §11). */
export function syncHandlers(deps: SyncDeps): Record<SyncKind, JobHandler> {
  return {
    discover: (job, signal) => runDiscover(deps, ofTenant(job), signal),
    events: (job, signal) => runEvents(deps, ofTenant(job), signal),
    maintenance: (job) => runMaintenance(job, deps.log.child({ job: job.target })),
    push_renew: (job, signal) => runPushRenew(deps, ofTenant(job), signal),
    sink: (job, signal) => runGoogleSink(deps, ofTenant(job), signal),
  };
}
