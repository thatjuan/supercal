import {
  apikey, apiKeyTenant, calendarAccount, calendarShare, davLogin, feed, NO_FRESHNESS,
  pushLease, sourceCalendar, syncTarget, verification, withTenant, type ControlDatabase, type TenantId,
} from '@supercal/db';
import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { notifyDavLoginRevoked, notifyFeedCredentialsRotated, publishAuthRevoked } from '../bus.ts';
import { pruneOrphanLinks } from '../hosted/access.ts';
import { accountTargets } from '../sync/context.ts';

/** Ends everything a member held in a tenant, so re-inviting them restores nothing. Run after the member row is gone. */
export async function endMembership(db: ControlDatabase, tenantId: TenantId, userId: string): Promise<void> {
  const keys = await withTenant(tenantId, async (tx) => {
    await tx.delete(calendarShare).where(eq(calendarShare.granteeUserId, userId));
    const logins = await tx.delete(davLogin).where(eq(davLogin.userId, userId)).returning({ id: davLogin.id });
    for (const login of logins) await notifyDavLoginRevoked(tx, login.id);
    const feeds = await tx.update(feed).set({ caldavPasswordHash: null, icsTokenHash: null })
      .where(eq(feed.ownerUserId, userId)).returning({ id: feed.id });
    for (const row of feeds) await notifyFeedCredentialsRotated(tx, row.id);
    const bindings = await tx.select({ id: apiKeyTenant.apiKeyId }).from(apiKeyTenant).where(eq(apiKeyTenant.userId, userId));
    await tx.delete(apiKeyTenant).where(eq(apiKeyTenant.userId, userId));
    const accounts = await tx.update(calendarAccount)
      .set({ status: 'disabled', credentials: null, statusDetail: 'The account owner left this tenant', updatedAt: new Date() })
      .where(and(eq(calendarAccount.ownerUserId, userId), ne(calendarAccount.provider, 'hosted')))
      .returning({ id: calendarAccount.id });
    for (const account of accounts) {
      await tx.update(syncTarget).set({ nextRunAt: sql`'infinity'::timestamptz` }).where(accountTargets(account));
      await tx.delete(pushLease).where(eq(pushLease.accountId, account.id));
      await tx.update(sourceCalendar)
        .set({ freshness: sql`${JSON.stringify(NO_FRESHNESS)}::jsonb || ${sourceCalendar.freshness} || '{"stale":true}'::jsonb` })
        .where(eq(sourceCalendar.accountId, account.id));
    }
    await pruneOrphanLinks(tx);
    return bindings.map((key) => key.id);
  });
  // Unbound keys are already unusable; delete their secrets after the tenant transaction commits.
  if (keys.length) await db.delete(apikey).where(inArray(apikey.id, keys));
  await publishAuthRevoked(db, userId);
}

/** Ends reusable access after account recovery; read-only feed credentials remain valid. */
export async function revokeLongLivedCredentials(db: ControlDatabase, userId: string): Promise<void> {
  await db.delete(verification).where(and(like(verification.identifier, 'reset-password:%'), eq(verification.value, userId)));
  await db.delete(apikey).where(eq(apikey.referenceId, userId));
  // The control role may read device logins, but only the tenant role may delete them.
  const logins = await db.select({ id: davLogin.id, tenantId: davLogin.tenantId }).from(davLogin).where(eq(davLogin.userId, userId));
  for (const login of logins) {
    await withTenant(login.tenantId, async (tx) => {
      await tx.delete(davLogin).where(eq(davLogin.id, login.id));
      await notifyDavLoginRevoked(tx, login.id);
    });
  }
}
