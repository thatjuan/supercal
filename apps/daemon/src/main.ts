import { connectDb, createControlDatabase, migrate } from '@supercal/db';
import { createAuth } from './auth/auth.ts';
import { loadConfig } from './config.ts';
import { createApp } from './http.ts';
import { createLogger } from './log.ts';
import { startWorker } from './worker/index.ts';

/** Keep in step with `packageManager` in the root package.json. */
const PINNED_BUN = '1.3.4';
const SHUTDOWN_GRACE_MS = 10_000;

const config = loadConfig();
const log = createLogger();
if (Bun.version !== PINNED_BUN) log.warn('unpinned Bun version', { expected: PINNED_BUN, actual: Bun.version });

if (config.SUPERCAL_MIGRATE === 'auto') {
  const { applied } = await migrate(config.DATABASE_MIGRATION_URL ?? config.DATABASE_URL);
  log.info('migrations applied', { applied });
}

connectDb(config.DATABASE_URL);
const auth = createAuth(config, createControlDatabase(config.DATABASE_URL));

const roles = config.SUPERCAL_ROLES;
const server = Bun.serve({ port: config.PORT, fetch: createApp(roles, auth).fetch });
log.info('listening', { port: server.port, roles: [...roles] });

const workerAbort = new AbortController();
const worker = roles.has('worker') ? startWorker(workerAbort.signal, log.child({ role: 'worker' })) : Promise.resolve();

let stopping = false;

/** Stops accepting connections, aborts the worker and exits once both finish or the grace period ends. */
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  workerAbort.abort();
  const finished = await Promise.race([
    Promise.all([server.stop(), worker]).then(() => true),
    Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
  ]);
  if (!finished) log.warn('shutdown grace period elapsed', { graceMs: SHUTDOWN_GRACE_MS });
  process.exit(finished ? 0 : 1);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
