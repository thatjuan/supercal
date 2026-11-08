/**
 * `POST /hooks/google`: Google push notifications (architecture §7). The channel id names a
 * `push_lease`, and the channel token must match its `secret_hash`; anything else is a 404. A
 * `sync` notification only confirms a new channel. Any other state makes the watched target due
 * now (the calendar's `events` target, or the account's `discover` target for the calendar list)
 * and wakes the workers. The body is never read: it carries nothing we trust.
 */
import { pushLease, syncTarget, withControl } from '@supercal/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { wakeTargets } from '../sync/scheduler.ts';
import { secretHash } from '../sync/push.ts';

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const googleHooks = new Hono().post('/hooks/google', async (c) => {
  const channelId = c.req.header('x-goog-channel-id');
  const token = c.req.header('x-goog-channel-token');
  if (!channelId || !token) return c.body(null, 404);
  const found = await withControl(async (tx) => {
    const [lease] = await tx
      .select({ target: pushLease.target, targetId: pushLease.targetId, accountId: pushLease.accountId, secretHash: pushLease.secretHash })
      .from(pushLease)
      .where(eq(pushLease.providerChannelId, channelId));
    if (!lease || !sameHash(lease.secretHash, secretHash(token))) return false;
    if (c.req.header('x-goog-resource-state') === 'sync') return true;
    const [kind, targetId] = lease.target === 'calendar' ? (['events', lease.targetId] as const) : (['discover', lease.accountId] as const);
    const targets = await tx.select({ id: syncTarget.id }).from(syncTarget).where(and(eq(syncTarget.kind, kind), eq(syncTarget.targetId, targetId)));
    await wakeTargets(tx, targets.map((t) => t.id));
    return true;
  });
  return c.body(null, found ? 200 : 404);
});
