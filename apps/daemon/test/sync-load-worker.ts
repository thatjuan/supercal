/**
 * One worker process of the scheduler load test (`sync-load.test.ts`): the real scheduler and
 * runner over `DATABASE_URL`, with a fake provider serving calendars `c0`…`c{CALENDARS-1}`.
 * Runs for `DURATION_MS`, then prints `{ owner, runs }` as JSON.
 */
import { closeDb, connectDb, createSecretBox } from '@supercal/db';
import { createGuardedFetch } from '@supercal/providers';
import { createFakeAdapter, fakeEvent } from '@supercal/providers/test/fake';
import { startBus } from '../src/bus.ts';
import { createLogger } from '../src/log.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { startScheduler, type JobHandler } from '../src/sync/scheduler.ts';

const url = process.env.DATABASE_URL ?? '';
const calendars = Number(process.env.CALENDARS);
const durationMs = Number(process.env.DURATION_MS);

const fake = createFakeAdapter({ delayMs: 100 });
for (let i = 0; i < calendars; i++) fake.calendar(`c${i}`).put(`e${i}`, fakeEvent(`e${i}@load`));

const log = createLogger({}, () => {});
connectDb(url);
const bus = await startBus(url, log);
const deps = createSyncDeps({
  secrets: await createSecretBox({ insecureDev: true, warn: () => {} }),
  fetch: createGuardedFetch({ allow: [] }),
  log,
  adapters: { ics: fake.adapter },
});
let runs = 0;
const all = syncHandlers(deps);
const counted: JobHandler = async (job, signal) => {
  const result = await all.events(job, signal);
  runs++;
  return result;
};

const owner = crypto.randomUUID();
const stop = new AbortController();
setTimeout(() => stop.abort(), durationMs);
// Twelve worker slots retain six active jobs for this single tenant under the default share.
await startScheduler({ handlers: { ...all, events: counted }, log, signal: stop.signal, bus, owner, concurrency: 12, leaseMs: 1000, pollMs: 200 });
await bus.close();
await closeDb();
console.log(JSON.stringify({ owner, runs }));
