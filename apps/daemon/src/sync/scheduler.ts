/**
 * The lease scheduler (architecture §8). Every worker process runs `startScheduler`, which claims
 * due `sync_target` rows with `FOR UPDATE SKIP LOCKED`, runs each through the handler for its kind,
 * renews the lease while it runs and aborts the job when the lease is lost. Claims, renewals and
 * completions are fenced by owner and `lease_version`, so a worker whose lease expired cannot
 * overwrite a newer claim; the runner fences its data writes the same way (`fenced` in runner.ts).
 */
import { syncTarget, withControl, type ControlTx, type SyncKind, type SyncTargetId, type TenantId, type TenantTx } from '@supercal/db';
import { ProviderThrottledError, type Provider } from '@supercal/providers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { wake, type Bus } from '../bus.ts';
import type { Logger } from '../log.ts';
import { metrics } from '../ops/metrics.ts';

/** A claimed target. `version` is the claim's `lease_version`, which every fenced write checks. */
export type Job = {
  id: SyncTargetId;
  tenantId: TenantId | null;
  kind: SyncKind;
  /** `sync_target.target_id`: the account, calendar or sink id, or a maintenance job name. */
  target: string;
  owner: string;
  version: number;
  wakeGeneration: number;
  /** Consecutive attempts, this one included. */
  attempts: number;
};

/** What a successful run asks for: the next run in `nextRunInMs` (`Infinity`: only when woken). */
export type JobResult = { nextRunInMs: number };

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<JobResult>;

/** The lease was lost to another worker; the job stops without completing. */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
}

/** The target must not run again until something wakes it (e.g. the account needs reauth). */
export class StopTargetError extends Error {
  override readonly name = 'StopTargetError';
}

/** The account has no free concurrency slot; the job must defer without an attempt. */
export class AccountBusyError extends Error {
  override readonly name = 'AccountBusyError';
}

/** The overall job deadline elapsed, even if individual requests kept making progress. */
export class JobDeadlineError extends Error {
  override readonly name = 'JobDeadlineError';
}

const ACCOUNT_BUSY_RETRY_MS = 5_000;
const MINUTE = 60_000;
const BACKOFF_CAP_MS = 60 * MINUTE;
const ERROR_CHARS = 1000;

const after = (ms: number) => (ms === Infinity ? sql`'infinity'::timestamptz` : sql`clock_timestamp() + ${Math.max(0, Math.round(ms))} * interval '1 millisecond'`);

/**
 * Claims up to `limit` due targets whose lease is free (only `ids`, when given) for `owner`,
 * bumping `lease_version` and `attempts`. Each tenant holds at most `tenantCap` leases for this owner;
 * maintenance is exempt. One statement, so concurrent workers never claim the same row.
 */
export async function claim(owner: string, { leaseMs, limit, ids, tenantCap = 4 }: { leaseMs: number; limit: number; ids?: readonly SyncTargetId[]; tenantCap?: number }): Promise<Job[]> {
  if (limit <= 0 || ids?.length === 0) return [];
  const only = ids ? sql`and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = await withControl((tx) =>
    tx.execute<{ id: SyncTargetId; tenant_id: TenantId | null; kind: SyncKind; target_id: string; lease_version: string; wake_generation: string; attempts: number }>(sql`
      with busy as (
        select tenant_id, count(*) as n from sync_target
        where lease_owner = ${owner} and lease_until >= clock_timestamp() and tenant_id is not null
        group by tenant_id),
      ranked as (
        select t.id, t.tenant_id, t.next_run_at,
          row_number() over (partition by t.tenant_id order by t.next_run_at, t.id) as rn
        from sync_target t
        where t.next_run_at <= clock_timestamp() and (t.lease_until is null or t.lease_until < clock_timestamp()) ${only}),
      allowed as (
        select r.id, r.next_run_at from ranked r left join busy b using (tenant_id)
        where r.tenant_id is null or r.rn + coalesce(b.n, 0) <= ${tenantCap}
        order by r.next_run_at, r.id limit ${limit}),
      due as (select id from sync_target where id in (select id from allowed) for update skip locked)
      update sync_target t set lease_owner = ${owner}, lease_until = ${after(leaseMs)},
        lease_version = t.lease_version + 1, attempts = t.attempts + 1
      from due where t.id = due.id
      returning t.id, t.tenant_id, t.kind, t.target_id, t.lease_version, t.wake_generation, t.attempts`),
  );
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    target: r.target_id,
    owner,
    version: Number(r.lease_version),
    wakeGeneration: Number(r.wake_generation),
    attempts: r.attempts,
  }));
}

const held = (job: Job) => and(eq(syncTarget.id, job.id), eq(syncTarget.leaseOwner, job.owner), eq(syncTarget.leaseVersion, job.version));

/** Extends the lease by `leaseMs`; false when another claim replaced it. */
export async function renew(job: Job, leaseMs: number): Promise<boolean> {
  const rows = await withControl((tx) => tx.update(syncTarget).set({ leaseUntil: after(leaseMs) }).where(held(job)).returning({ id: syncTarget.id }));
  return rows.length > 0;
}

/** Capped exponential backoff with equal jitter: half the delay is fixed, half random. */
export function backoffMs(attempts: number, random = Math.random()): number {
  return Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(Math.max(attempts - 1, 0), 16)) * (0.5 + random * 0.5);
}

export type Outcome = { ok: true; nextRunInMs: number } | { ok: false; error: unknown };

/**
 * Finishes a run and frees the lease, if `job` still holds it. Success resets `attempts` and runs
 * again at once when the target was woken during the run. Failure keeps `attempts` and backs off,
 * no sooner than a throttle's retry-after; `StopTargetError` parks the target until woken.
 */
export async function complete(job: Job, outcome: Outcome): Promise<boolean> {
  const free = { leaseOwner: null, leaseUntil: null };
  const set = outcome.ok
    ? {
        ...free,
        attempts: 0,
        lastError: null,
        retryAfter: null,
        lastSuccessAt: sql`clock_timestamp()`,
        nextRunAt: sql`case when ${syncTarget.wakeGeneration} > ${job.wakeGeneration} then clock_timestamp() else ${after(outcome.nextRunInMs)} end`,
      }
    : {
        ...free,
        lastError: (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, ERROR_CHARS),
        retryAfter: outcome.error instanceof ProviderThrottledError ? after(outcome.error.retryAfterMs) : null,
        nextRunAt: after(
          outcome.error instanceof StopTargetError
            ? Infinity
            : Math.max(backoffMs(job.attempts), outcome.error instanceof ProviderThrottledError ? outcome.error.retryAfterMs : 0),
        ),
      };
  const rows = await withControl((tx) => tx.update(syncTarget).set(set).where(held(job)).returning({ id: syncTarget.id }));
  return rows.length > 0;
}

/** Gives the lease back unfinished (on shutdown), so another worker can run the target now. */
export async function release(job: Job): Promise<void> {
  await withControl((tx) =>
    tx
      .update(syncTarget)
      .set({ leaseOwner: null, leaseUntil: null, nextRunAt: sql`clock_timestamp()`, attempts: sql`greatest(${syncTarget.attempts} - 1, 0)` })
      .where(held(job)),
  );
}

/** Frees a busy account's lease without recording a run or spending an attempt. */
export async function defer(job: Job, ms: number): Promise<void> {
  await withControl((tx) => tx.update(syncTarget)
    .set({ leaseOwner: null, leaseUntil: null, nextRunAt: after(ms), attempts: sql`greatest(${syncTarget.attempts} - 1, 0)` })
    .where(held(job)));
}

/**
 * Makes `ids` due now and bumps their `wake_generation` (so a run in progress runs again at once),
 * then NOTIFYs workers on commit. What a webhook, a manual sync or a new calendar does.
 */
export async function wakeTargets(tx: TenantTx | ControlTx, ids: readonly SyncTargetId[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(syncTarget)
    .set({ nextRunAt: sql`clock_timestamp()`, wakeGeneration: sql`${syncTarget.wakeGeneration} + 1` })
    .where(inArray(syncTarget.id, [...ids]));
  await wake(tx, ids);
}

export const DISCOVER_EVERY_MS = 30 * MINUTE;
const PUSH_SAFETY_POLL_MS = 30 * MINUTE;

/** Poll bounds per provider; `defaultMs: 'decay'` polls as often as the calendar last changed, within the bounds. */
const CADENCE: Record<Exclude<Provider, 'hosted'>, { defaultMs: number | 'decay'; minMs: number; maxMs: number }> = {
  google: { defaultMs: 2 * MINUTE, minMs: MINUTE, maxMs: 30 * MINUTE },
  microsoft: { defaultMs: 2 * MINUTE, minMs: MINUTE, maxMs: 30 * MINUTE },
  caldav: { defaultMs: 'decay', minMs: MINUTE, maxMs: 5 * MINUTE },
  icloud: { defaultMs: 'decay', minMs: MINUTE, maxMs: 5 * MINUTE },
  ics: { defaultMs: 15 * MINUTE, minMs: 5 * MINUTE, maxMs: 60 * MINUTE },
};

/**
 * The next-run policy for an `events` target after a successful run: a safety poll with healthy
 * push, else the adapter's hint or the provider's default, clamped to the provider's bounds.
 */
export function nextPollMs({ provider, pushActive, hintMs, sinceChangeMs }: { provider: Provider; pushActive: boolean; hintMs?: number | undefined; sinceChangeMs: number | null }): number {
  if (provider === 'hosted') return Infinity;
  if (pushActive) return PUSH_SAFETY_POLL_MS;
  const { defaultMs, minMs, maxMs } = CADENCE[provider];
  const wanted = hintMs ?? (defaultMs === 'decay' ? (sinceChangeMs ?? maxMs) : defaultMs);
  return Math.min(maxMs, Math.max(minMs, wanted));
}

/** Per-account concurrency limit; busy accounts refuse immediately instead of queuing jobs. */
export function createSlots(limit: number) {
  const active = new Map<string, number>();
  return async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const count = active.get(key) ?? 0;
    if (count >= limit) throw new AccountBusyError('the account is busy');
    active.set(key, count + 1);
    try {
      return await fn();
    } finally {
      const remaining = (active.get(key) ?? 1) - 1;
      if (remaining === 0) active.delete(key);
      else active.set(key, remaining);
    }
  };
}

export type SchedulerOptions = {
  handlers: Record<SyncKind, JobHandler>;
  log: Logger;
  signal: AbortSignal;
  /** Claims woken targets at once; without a bus the scheduler only polls. */
  bus?: Bus;
  owner?: string;
  /** Jobs at once in this process (`SUPERCAL_SYNC_CONCURRENCY`). */
  concurrency?: number;
  /** Concurrent jobs per tenant in this process; maintenance is exempt. */
  tenantCap?: number;
  /** Overall job deadline, including all provider requests (default 30 minutes). */
  jobDeadlineMs?: number;
  leaseMs?: number;
  pollMs?: number;
  /** Called after every loop pass whose claims reached the database; `/readyz` watches it. */
  onTick?: () => void;
};

/**
 * Runs the claim loop until `signal` aborts, then waits for running jobs (aborted, and their
 * leases released) before resolving. Claims every `pollMs`, at once on a bus `wake`, and whenever
 * a job finishes.
 */
export async function startScheduler({ handlers, log, signal, bus, owner = crypto.randomUUID(), concurrency = 8, tenantCap = Math.max(1, Math.ceil(concurrency / 2)), jobDeadlineMs = 30 * MINUTE, leaseMs = 60_000, pollMs = 5_000, onTick }: SchedulerOptions): Promise<void> {
  const running = new Set<Promise<void>>();
  const woken = new Set<SyncTargetId>();
  let kicked = false;
  let wakeUp = () => {};
  const kick = () => {
    kicked = true;
    wakeUp();
  };
  const unsubscribe = [
    bus?.on('wake', ({ targetIds }) => {
      for (const id of targetIds) woken.add(id);
      kick();
    }),
    bus?.on('reconnected', kick),
  ];

  async function run(job: Job) {
    const jobLog = log.child({ targetId: job.id, kind: job.kind, target: job.target, version: job.version });
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('worker stopping'));
    signal.addEventListener('abort', stop, { once: true });
    const renewal = setInterval(() => {
      renew(job, leaseMs)
        .then((ok) => ok || controller.abort(new LeaseLostError('lease lost')))
        .catch((error) => jobLog.warn('lease renewal failed', { error }));
    }, leaseMs / 3);
    const deadline = setTimeout(() => controller.abort(new JobDeadlineError('the job ran past its deadline')), jobDeadlineMs);
    try {
      const { nextRunInMs } = await handlers[job.kind](job, controller.signal);
      if (controller.signal.reason instanceof JobDeadlineError) throw controller.signal.reason;
      if (!(await complete(job, { ok: true, nextRunInMs }))) {
        metrics.leaseLost.inc({});
        jobLog.warn('completion rejected: lease lost');
      }
    } catch (error) {
      if (error instanceof AccountBusyError) await defer(job, ACCOUNT_BUSY_RETRY_MS);
      else if (error instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError) {
        metrics.leaseLost.inc({});
        jobLog.warn('job stopped: lease lost');
      } else if (signal.aborted) await release(job);
      else {
        jobLog.warn('job failed', { error, attempts: job.attempts });
        await complete(job, { ok: false, error: controller.signal.reason instanceof JobDeadlineError ? controller.signal.reason : error });
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(renewal);
      signal.removeEventListener('abort', stop);
    }
  }

  const start = (job: Job) => {
    const task = run(job)
      .catch((error) => log.error('job bookkeeping failed', { targetId: job.id, error }))
      .finally(() => {
        running.delete(task);
        kick();
      });
    running.add(task);
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        wakeUp = () => {};
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      wakeUp = done;
      if (kicked || signal.aborted) done();
    });

  log.info('scheduler started', { owner, concurrency, leaseMs });
  while (!signal.aborted) {
    kicked = false;
    let claimed = 0;
    let free = concurrency - running.size;
    try {
      if (free > 0 && woken.size > 0) {
        const ids = [...woken];
        woken.clear();
        const jobs = await claim(owner, { leaseMs, limit: free, ids, tenantCap });
        jobs.forEach(start);
        free -= jobs.length;
      }
      if (free > 0) {
        const jobs = await claim(owner, { leaseMs, limit: free, tenantCap });
        jobs.forEach(start);
        claimed = jobs.length;
      }
      onTick?.();
    } catch (error) {
      log.warn('claim failed', { error });
    }
    // A full batch means more may be due: claim again as soon as a slot frees.
    if (claimed > 0 && claimed === free) continue;
    await pause(pollMs);
  }
  for (const off of unsubscribe) off?.();
  await Promise.all(running);
  log.info('scheduler stopped', { owner });
}
