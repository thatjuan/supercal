/**
 * `push_renew` targets keep one push subscription alive per calendar (Google `events.watch`), or
 * per account for calendar discovery (Google `calendarList.watch`). Push needs a public https URL;
 * without one (`pushBaseUrl` null) the targets park and calendars are polled.
 *
 * A run subscribes when no lease exists, and otherwise waits until 80% of the newest lease's
 * lifetime. Renewal stores the new lease before stopping and deleting the old ones, so the two
 * overlap and no notification is lost. Each lease's token is a fresh random secret stored only as
 * its sha256 (`secret_hash`), which `/hooks/<provider>` checks.
 */
import { createHash, randomBytes } from 'node:crypto';
import { calendarAccount, pushLease, sourceCalendar, withTenant, type AccountId, type CalendarAccount, type PushLease, type PushTarget, type SourceCalendarId } from '@supercal/db';
import type { JsonValue, PushLeaseInfo, PushRequest } from '@supercal/providers';
import { and, eq } from 'drizzle-orm';
import { withAccount, type SyncDeps, type TenantJob } from './context.ts';
import { fenced } from './runner.ts';
import { StopTargetError, type JobResult } from './scheduler.ts';

/** Share of a lease's lifetime after which it is renewed. */
const RENEW_AT = 0.8;

export const secretHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** When `lease` is due for renewal, in epoch ms. */
export const renewalDue = ({ createdAt, expiresAt }: Pick<PushLease, 'createdAt' | 'expiresAt'>) =>
  createdAt.getTime() + RENEW_AT * (expiresAt.getTime() - createdAt.getTime());

// `provider_state` is whatever the adapter returned when it subscribed.
const leaseInfo = (lease: PushLease): PushLeaseInfo => ({ ...lease, providerState: lease.providerState as JsonValue | null });

/** What the job's `target_id` names: a calendar's watch, or the account's calendar-list watch. */
async function load(job: TenantJob): Promise<{ account: CalendarAccount; target: PushTarget; providerTargetId: string; leases: PushLease[] }> {
  return withTenant(job.tenantId, async (tx) => {
    const [calendar] = await tx
      .select()
      .from(sourceCalendar)
      .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
      .where(eq(sourceCalendar.id, job.target as SourceCalendarId));
    const [account] = calendar ? [calendar.calendar_account] : await tx.select().from(calendarAccount).where(eq(calendarAccount.id, job.target as AccountId));
    if (!account || calendar?.source_calendar.state === 'gone') throw new StopTargetError('the push target is gone');
    const target: PushTarget = calendar ? 'calendar' : 'calendar-list';
    const leases = await tx.select().from(pushLease).where(and(eq(pushLease.target, target), eq(pushLease.targetId, job.target)));
    return { account, target, providerTargetId: calendar?.source_calendar.providerCalendarId ?? account.id, leases };
  });
}

/** Runs one `push_renew` job: subscribe or renew if due, and return when to look again. */
export async function runPushRenew(deps: SyncDeps, job: TenantJob, signal: AbortSignal): Promise<JobResult> {
  if (!deps.pushBaseUrl) return { nextRunInMs: Infinity };
  const { account, target, providerTargetId, leases } = await load(job);
  const newest = leases.toSorted((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
  if (newest && renewalDue(newest) > Date.now()) return { nextRunInMs: renewalDue(newest) - Date.now() };

  const address = `${deps.pushBaseUrl}/hooks/${account.provider}`;
  return withAccount(deps, job, account, signal, async (adapter, ctx) => {
    if (!adapter.push) throw new StopTargetError(`${account.provider} has no push`);
    const token = randomBytes(32).toString('base64url');
    const request: PushRequest = { target, targetId: job.target, providerTargetId, address, token };
    const next = newest ? await adapter.push.renew(ctx, leaseInfo(newest), request) : await adapter.push.subscribe(ctx, request);
    const createdAt = new Date();
    await fenced(job, (tx) =>
      tx
        .insert(pushLease)
        .values({ ...next, createdAt, tenantId: account.tenantId, accountId: account.id, secretHash: secretHash(token) })
        // A provider that extends a subscription in place keeps its id, and its original secret.
        .onConflictDoUpdate({ target: pushLease.providerChannelId, set: { expiresAt: next.expiresAt, providerResourceId: next.providerResourceId, providerState: next.providerState, createdAt } }),
    );
    for (const old of leases) {
      if (old.providerChannelId === next.providerChannelId) continue;
      await adapter.push.teardown(ctx, leaseInfo(old)).catch((error: unknown) => ctx.log.warn('stopping a replaced push channel failed; it will expire', { error }));
      await withTenant(account.tenantId, (tx) => tx.delete(pushLease).where(eq(pushLease.providerChannelId, old.providerChannelId)));
    }
    return { nextRunInMs: Math.max(0, renewalDue({ createdAt, expiresAt: next.expiresAt }) - Date.now()) };
  });
}
