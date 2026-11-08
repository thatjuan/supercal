import type { SecretBox } from '@supercal/db';
import type { AdapterRegistry, GoogleClientOptions, GuardedFetch } from '@supercal/providers';
import type { Bus } from '../bus.ts';
import type { Logger } from '../log.ts';
import { watchSinks } from '../sinks/wake.ts';
import { createSyncDeps, syncHandlers } from '../sync/index.ts';
import { registerMaintenance } from '../sync/maintenance.ts';
import { startScheduler } from '../sync/scheduler.ts';

export type WorkerOptions = {
  secrets: SecretBox;
  bus: Bus;
  fetch: GuardedFetch;
  /** `SUPERCAL_SYNC_CONCURRENCY`. */
  concurrency: number;
  adapters?: AdapterRegistry;
  /** See `SyncDeps.pushBaseUrl`. */
  pushBaseUrl?: string | null;
  /** See `SchedulerOptions.onTick`. */
  onTick?: () => void;
  /** The Google OAuth client; enables Google sinks. */
  google?: GoogleClientOptions | undefined;
};

/** Runs the worker role until `signal` aborts: registers the maintenance jobs, wakes sinks on changes, and runs the sync scheduler. */
export async function startWorker(signal: AbortSignal, log: Logger, { secrets, bus, fetch, concurrency, adapters, pushBaseUrl, onTick, google }: WorkerOptions): Promise<void> {
  await registerMaintenance();
  const deps = createSyncDeps({ secrets, fetch, log, pushBaseUrl, google, ...(adapters && { adapters }) });
  const stopSinks = watchSinks(bus, log.child({ component: 'sinks' }));
  try {
    await startScheduler({ handlers: syncHandlers(deps), log, signal, bus, concurrency, ...(onTick && { onTick }) });
  } finally {
    stopSinks();
  }
}
