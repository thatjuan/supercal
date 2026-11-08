/**
 * Ops endpoints (architecture §12), mounted by `createApp` for every role:
 * - `GET /readyz`: 200 when every check passes, otherwise 503 listing the failing ones. Checks: the
 *   database answers within 1 s, its newest migration is this binary's, the bus hears its own
 *   pings, and (worker role) the scheduler loop ticked in the last 30 s.
 * - `GET /metrics`: Prometheus text, behind `Authorization: Bearer <SUPERCAL_METRICS_TOKEN>` when set.
 */
import { migrationsCurrent, withControl } from '@supercal/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Bus } from '../bus.ts';
import { metrics, registry } from './metrics.ts';
import { PROMETHEUS_CONTENT_TYPE } from './registry.ts';

const DATABASE_TIMEOUT_MS = 1_000;
const SCHEDULER_STALE_MS = 30_000;

export type OpsDeps = {
  bus: Bus;
  /** When the scheduler last ticked (epoch ms, null before the first); only with the worker role. */
  schedulerTickedAt?: () => number | null;
  /** `SUPERCAL_METRICS_TOKEN`. */
  metricsToken?: string | undefined;
};

type Check = 'database' | 'migrations' | 'bus' | 'scheduler';

/** The database checks in one control transaction, bounded by `DATABASE_TIMEOUT_MS`. */
async function databaseChecks(): Promise<Check[]> {
  const work = withControl(async (tx): Promise<Check[]> => {
    await tx.execute(sql`select 1`);
    return (await migrationsCurrent(tx)) ? [] : ['migrations'];
  });
  const timeout = Bun.sleep(DATABASE_TIMEOUT_MS).then((): Check[] => ['database']);
  return Promise.race([work.catch((): Check[] => ['database']), timeout]);
}

/** Every failing readiness check; empty when the process is ready. */
export async function failingChecks({ bus, schedulerTickedAt }: Pick<OpsDeps, 'bus' | 'schedulerTickedAt'>): Promise<Check[]> {
  const failing = await databaseChecks();
  if (!bus.connected) failing.push('bus');
  const ticked = schedulerTickedAt?.();
  if (schedulerTickedAt && (ticked === null || ticked === undefined || Date.now() - ticked > SCHEDULER_STALE_MS)) failing.push('scheduler');
  return failing;
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Observes notify lag on every change notification this process receives. Call once per bus. */
export function instrumentBus(bus: Bus) {
  return bus.on('change', ({ sentAt }) => {
    if (sentAt !== undefined) metrics.notifyLag.observe({}, Math.max(0, Date.now() - sentAt) / 1000);
  });
}

export function opsRoutes(deps: OpsDeps) {
  return new Hono()
    .get('/readyz', async (c) => {
      const failing = await failingChecks(deps);
      return failing.length === 0 ? c.json({ status: 'ready' }) : c.json({ status: 'not ready', failing }, 503);
    })
    .get('/metrics', async (c) => {
      if (deps.metricsToken && !sameSecret(c.req.header('Authorization') ?? '', `Bearer ${deps.metricsToken}`))
        return c.body('unauthorized', 401, { 'WWW-Authenticate': 'Bearer' });
      return c.body(await registry.render(), 200, { 'Content-Type': PROMETHEUS_CONTENT_TYPE });
    });
}
