/**
 * Microsoft Graph change notifications (architecture §7, §8) for the mailbox-wide `/me/events`
 * subscription of each account:
 *
 * - `?validationToken=…` on either endpoint is Graph checking the URL: it is echoed back as
 *   `text/plain` at once.
 * - `POST /hooks/microsoft`: each notification's `subscriptionId` names a `push_lease`, and its
 *   `clientState` must match the lease's `secret_hash`; anything else is ignored. A mailbox-wide
 *   notification does not reliably say which calendar changed, so it wakes every `events` target
 *   of the account. Always 202: the body carries nothing we trust.
 * - `POST /hooks/microsoft/lifecycle`: `reauthorizationRequired` marks the lease expired and wakes
 *   its `push_renew` target, which renews it now; `subscriptionRemoved` drops the lease, so the
 *   target subscribes afresh; `missed` wakes every target of the account for a full reconciliation.
 */
import { pushLease, sourceCalendar, syncTarget, withControl, withTenant, type PushLease } from '@supercal/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { accountTargets } from '../sync/context.ts';
import { secretHash } from '../sync/push.ts';
import { wakeTargets } from '../sync/scheduler.ts';

const Notifications = z.object({
  value: z.array(z.object({ subscriptionId: z.string(), clientState: z.string().nullish(), lifecycleEvent: z.string().nullish() })).max(1000),
});
type Notification = z.infer<typeof Notifications>['value'][number];
type Lease = Pick<PushLease, 'providerChannelId' | 'tenantId' | 'accountId' | 'targetId'>;

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The notifications whose subscription is a lease of ours and whose `clientState` matches it, with that lease. */
async function verified(items: Notification[]): Promise<{ item: Notification; lease: Lease }[]> {
  const ids = [...new Set(items.map((i) => i.subscriptionId))];
  if (ids.length === 0) return [];
  const leases = await withControl((tx) =>
    tx
      .select({ providerChannelId: pushLease.providerChannelId, tenantId: pushLease.tenantId, accountId: pushLease.accountId, targetId: pushLease.targetId, secretHash: pushLease.secretHash })
      .from(pushLease)
      .where(and(eq(pushLease.target, 'account'), inArray(pushLease.providerChannelId, ids))),
  );
  const byId = new Map(leases.map((l) => [l.providerChannelId, l]));
  return items.flatMap((item) => {
    const lease = byId.get(item.subscriptionId);
    return lease && item.clientState && sameHash(lease.secretHash, secretHash(item.clientState)) ? [{ item, lease }] : [];
  });
}

/** Graph's URL check: the decoded token back as plain text; null for an ordinary delivery. */
function validation(c: Context): Response | null {
  const token = c.req.query('validationToken');
  return token === undefined ? null : c.text(token, 200);
}

/** The notifications in the body, or null when it is not Graph's shape. */
async function notifications(c: Context): Promise<Notification[] | null> {
  const body = Notifications.safeParse(await c.req.json().catch(() => null));
  return body.success ? body.data.value : null;
}

/** Wakes the `events` targets of every calendar of the account. */
async function wakeCalendars(lease: Lease) {
  await withTenant(lease.tenantId, async (tx) => {
    const calendars = tx.select({ id: sourceCalendar.id }).from(sourceCalendar).where(eq(sourceCalendar.accountId, lease.accountId));
    const targets = await tx.select({ id: syncTarget.id }).from(syncTarget).where(and(eq(syncTarget.kind, 'events'), inArray(syncTarget.targetId, calendars)));
    await wakeTargets(tx, targets.map((t) => t.id));
  });
}

/** Applies one lifecycle event to its lease. */
async function lifecycle(event: string, lease: Lease) {
  await withTenant(lease.tenantId, async (tx) => {
    const renewTarget = and(eq(syncTarget.kind, 'push_renew'), eq(syncTarget.targetId, lease.targetId));
    const thisLease = eq(pushLease.providerChannelId, lease.providerChannelId);
    if (event === 'reauthorizationRequired') await tx.update(pushLease).set({ expiresAt: sql`clock_timestamp()` }).where(thisLease);
    else if (event === 'subscriptionRemoved') await tx.delete(pushLease).where(thisLease);
    const targets = await tx
      .select({ id: syncTarget.id })
      .from(syncTarget)
      .where(event === 'missed' ? accountTargets({ id: lease.accountId }) : renewTarget);
    await wakeTargets(tx, targets.map((t) => t.id));
  });
}

export const microsoftHooks = new Hono()
  .use('/hooks/microsoft/*', bodyLimit({ maxSize: 256 * 1024 }))
  .post('/hooks/microsoft', async (c) => {
    const echo = validation(c);
    if (echo) return echo;
    const items = await notifications(c);
    if (!items) return c.body(null, 400);
    const accounts = new Map((await verified(items)).map(({ lease }) => [lease.accountId, lease]));
    for (const lease of accounts.values()) await wakeCalendars(lease);
    return c.body(null, 202);
  })
  .post('/hooks/microsoft/lifecycle', async (c) => {
    const echo = validation(c);
    if (echo) return echo;
    const items = await notifications(c);
    if (!items) return c.body(null, 400);
    for (const { item, lease } of await verified(items)) if (item.lifecycleEvent) await lifecycle(item.lifecycleEvent, lease);
    return c.body(null, 202);
  });
