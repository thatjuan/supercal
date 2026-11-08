import { connectDb, createControlDatabase, createSecretBox, migrate } from '@supercal/db';
import { createGoogleAdapter, createGuardedFetch, createMicrosoftAdapter, GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, registry } from '@supercal/providers';
import { createAuth } from './auth/auth.ts';
import { startBus } from './bus.ts';
import { loadConfig } from './config.ts';
import { createApp } from './http.ts';
import { createLogger } from './log.ts';
import { GOOGLE_AUTHORIZE_URL } from './oauth/google.ts';
import { MICROSOFT_AUTHORIZE_URL } from './oauth/microsoft.ts';
import { defaultWebDir } from './web.ts';
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
const secrets = await createSecretBox({ keys: config.SUPERCAL_KEYS, insecureDev: config.SUPERCAL_INSECURE_DEV, warn: (message) => log.warn(message) });

const bus = await startBus(config.DATABASE_URL, log.child({ component: 'bus' }));
const egress = createGuardedFetch({ allow: config.SUPERCAL_EGRESS_ALLOW });

// Google and Microsoft are enabled by their client credentials; push additionally needs a public https URL.
const pushBaseUrl = config.SUPERCAL_PUBLIC_URL?.startsWith('https:') ? config.SUPERCAL_PUBLIC_URL.replace(/\/+$/, '') : null;
const google =
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
    ? { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET, authorizeUrl: GOOGLE_AUTHORIZE_URL, tokenUrl: GOOGLE_TOKEN_URL }
    : undefined;
const microsoft =
  config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET
    ? { clientId: config.MICROSOFT_CLIENT_ID, clientSecret: config.MICROSOFT_CLIENT_SECRET, authorizeUrl: MICROSOFT_AUTHORIZE_URL, tokenUrl: MICROSOFT_TOKEN_URL }
    : undefined;
if ((google || microsoft) && !pushBaseUrl) log.info('push is disabled because SUPERCAL_PUBLIC_URL is not https; Google and Microsoft calendars are polled every 2 minutes');
const adapters = {
  ...registry,
  ...(google && { google: createGoogleAdapter({ ...google, push: pushBaseUrl !== null }) }),
  ...(microsoft && { microsoft: createMicrosoftAdapter({ ...microsoft, push: pushBaseUrl !== null }) }),
};

const roles = config.SUPERCAL_ROLES;
// The live stream turns off the idle timeout for its own requests (`server.timeout(req, 0)`), and
// closes when `stopAbort` aborts, since `server.stop()` waits for open streams.
const stopAbort = new AbortController();
const webDir = config.SUPERCAL_WEB_DIR ?? defaultWebDir();
const server = Bun.serve({
  port: config.PORT,
  fetch: createApp(roles, {
    auth,
    secrets,
    bus,
    fetch: egress,
    adapters,
    oauth: { webOrigin: config.WEB_ORIGIN, stateSecret: config.BETTER_AUTH_SECRET ?? crypto.randomUUID(), google, microsoft },
    stream: { signal: stopAbort.signal },
    publicUrl: config.SUPERCAL_PUBLIC_URL,
    icsCacheBytes: config.SUPERCAL_ICS_CACHE_MB * 1024 * 1024,
    signup: config.SUPERCAL_SIGNUP,
    webDir,
  }).fetch,
});
log.info('listening', { port: server.port, roles: [...roles], webDir });

const worker = roles.has('worker')
  ? startWorker(stopAbort.signal, log.child({ role: 'worker' }), { secrets, bus, fetch: egress, adapters, pushBaseUrl, concurrency: config.SUPERCAL_SYNC_CONCURRENCY })
  : Promise.resolve();

let stopping = false;

/** Stops accepting connections, aborts the worker and live streams, and exits once both finish or the grace period ends. */
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  stopAbort.abort();
  const finished = await Promise.race([
    Promise.all([server.stop(), worker]).then(() => bus.close()).then(() => true),
    Bun.sleep(SHUTDOWN_GRACE_MS).then(() => false),
  ]);
  if (!finished) log.warn('shutdown grace period elapsed', { graceMs: SHUTDOWN_GRACE_MS });
  process.exit(finished ? 0 : 1);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
