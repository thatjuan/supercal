import { calendarAccount, newId, sourceCalendar, type SourceCalendar, type SourceCalendarId, type TenantTx } from '@supercal/db';
import { and, count, eq, sql } from 'drizzle-orm';
import { NotFound, ProblemError } from '../api/kit/problem.ts';
import type { FeedService } from '../feeds/service.ts';
import { lockHostedCalendar } from './objects.ts';

export const HOSTED_ACCOUNT_LOCK = 1937011299;
export const MAX_CALENDARS_PER_USER = 100;
export type CalendarInput = { name: string; color?: string | undefined; timezone?: string | undefined; description?: string | undefined };

/** One hidden account per user; the lock also serializes that user's calendar quota checks. */
export async function getOrCreateHostedAccount(tx: TenantTx, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(${HOSTED_ACCOUNT_LOCK}, hashtext(${userId}))`);
  const [existing] = await tx.select().from(calendarAccount)
    .where(and(eq(calendarAccount.ownerUserId, userId), eq(calendarAccount.provider, 'hosted')));
  if (existing) return existing;
  const [account] = await tx.insert(calendarAccount).values({
    tenantId: sql`current_setting('app.tenant_id')`,
    ownerUserId: userId,
    provider: 'hosted',
    displayName: 'Supercal',
    autoPublish: false,
  }).returning();
  if (!account) throw new Error('Hosted account insert returned no row');
  return account;
}

/** Creates a retained calendar and its initially disabled passthrough publication. */
export async function createCalendar(tx: TenantTx, feeds: FeedService, userId: string, input: CalendarInput): Promise<SourceCalendar> {
  const account = await getOrCreateHostedAccount(tx, userId);
  const [total] = await tx.select({ count: count() }).from(sourceCalendar).where(eq(sourceCalendar.accountId, account.id));
  if ((total?.count ?? 0) >= MAX_CALENDARS_PER_USER) throw new ProblemError(409, 'Calendar quota exceeded', undefined, 'calendar-quota');
  const id = newId('cal');
  const [calendar] = await tx.insert(sourceCalendar).values({
    id,
    tenantId: account.tenantId,
    accountId: account.id,
    providerCalendarId: id,
    ...input,
    timezone: input.timezone ?? 'UTC',
    capabilities: { incremental: 'hosted', push: false },
  }).returning();
  if (!calendar) throw new Error('Calendar insert returned no row');
  await feeds.ensurePassthroughPublication(tx, calendar, account);
  return calendar;
}

/** Soft deletion retains authoritative raw objects for 30 days. */
export async function deleteCalendar(tx: TenantTx, feeds: FeedService, id: SourceCalendarId): Promise<void> {
  await lockHostedCalendar(tx, id);
  await tx.update(sourceCalendar)
    .set({ state: 'gone', goneAt: sql`coalesce(${sourceCalendar.goneAt}, now())`, updatedAt: new Date() })
    .where(eq(sourceCalendar.id, id));
  await feeds.onCalendarGone(tx, id);
}

/** Restores data; publication settings and virtual memberships stay as deletion left them. */
export async function restoreCalendar(tx: TenantTx, id: SourceCalendarId): Promise<SourceCalendar> {
  await lockHostedCalendar(tx, id);
  const [calendar] = await tx.select().from(sourceCalendar).where(eq(sourceCalendar.id, id));
  if (!calendar) throw new NotFound('No such calendar');
  if (calendar.state !== 'gone') throw new ProblemError(409, 'Calendar is not deleted');
  const [restored] = await tx.update(sourceCalendar)
    .set({ state: 'active', goneAt: null, updatedAt: new Date() })
    .where(eq(sourceCalendar.id, id)).returning();
  if (!restored) throw new NotFound('No such calendar');
  return restored;
}
