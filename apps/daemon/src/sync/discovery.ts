/**
 * Calendar discovery (`discover` targets, one per account, every 30 min): the provider's calendar
 * listing becomes `source_calendar` rows. A new calendar is published (passthrough, in the owner's
 * default feed) and gets an `events` target due now, plus a `push_renew` target when it supports
 * push. A calendar missing from a successful listing is marked gone, its publications disabled and
 * its targets and push leases removed; a failed listing changes nothing. Calendars a sink writes to
 * are never sources (loop prevention): their `sink` rows are checked here, and the Google adapter
 * leaves out calendars carrying the managed marker, which covers mirrors whose row is gone.
 */
import {
  calendarAccount,
  pushLease,
  sink,
  sourceCalendar,
  syncTarget,
  withTenant,
  type CalendarAccount,
  type SourceCalendar,
  type SyncTargetId,
  type TenantTx,
} from '@supercal/db';
import type { SourceCalendarInfo } from '@supercal/providers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FeedService } from '../feeds/service.ts';
import { withAccount, type SyncDeps, type TenantJob } from './context.ts';
import { fenced } from './runner.ts';
import { DISCOVER_EVERY_MS, StopTargetError, wakeTargets, type JobResult } from './scheduler.ts';

export const MAX_CALENDARS_PER_ACCOUNT = 100;

/** Creates (or makes due now) the `kind` target of `targetId`; returns its id. */
export async function ensureTarget(tx: TenantTx, account: Pick<CalendarAccount, 'tenantId'>, kind: 'discover' | 'events' | 'push_renew', targetId: string): Promise<SyncTargetId> {
  const [row] = await tx
    .insert(syncTarget)
    .values({ tenantId: account.tenantId, kind, targetId, nextRunAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({ target: [syncTarget.kind, syncTarget.targetId], set: { nextRunAt: sql`clock_timestamp()` } })
    .returning({ id: syncTarget.id });
  if (!row) throw new Error('sync target upsert returned no row');
  return row.id;
}

/**
 * Applies a successful listing to the account's calendars and returns the active ones. With
 * `sweep`, calendars missing from it are marked gone (`onCalendarGone`) and lose their targets.
 */
export async function applyListing(
  tx: TenantTx,
  feeds: FeedService,
  account: CalendarAccount,
  infos: SourceCalendarInfo[],
  { sweep }: { sweep: boolean },
): Promise<SourceCalendar[]> {
  const sinks = account.providerSubject
    ? await tx
        .select({ providerCalendarId: sink.providerCalendarId })
        .from(sink)
        .where(and(eq(sink.provider, account.provider), eq(sink.providerSubject, account.providerSubject)))
    : [];
  const written = new Set(sinks.map((s) => s.providerCalendarId));
  // Choose the same calendars regardless of the provider's listing order.
  const available = infos.filter((info) => !written.has(info.providerCalendarId))
    .sort((a, b) => a.providerCalendarId < b.providerCalendarId ? -1 : a.providerCalendarId > b.providerCalendarId ? 1 : 0);
  const listed = available.slice(0, MAX_CALENDARS_PER_ACCOUNT);
  await tx.update(calendarAccount).set({
    statusDetail: available.length > MAX_CALENDARS_PER_ACCOUNT ? `Syncing the first 100 of ${available.length} calendars` : null,
  }).where(eq(calendarAccount.id, account.id));
  const before = new Map((await tx.select().from(sourceCalendar).where(eq(sourceCalendar.accountId, account.id))).map((c) => [c.providerCalendarId, c]));

  const active: SourceCalendar[] = [];
  const woken: SyncTargetId[] = [];
  for (const { providerCalendarId, name, color, timezone, capabilities: discovered } of listed) {
    const capabilities = { ...discovered, write: discovered.write === true };
    const [row] = await tx
      .insert(sourceCalendar)
      .values({ tenantId: account.tenantId, accountId: account.id, providerCalendarId, name, color, timezone, capabilities })
      .onConflictDoUpdate({ target: [sourceCalendar.accountId, sourceCalendar.providerCalendarId], set: { name, color, timezone, capabilities, state: 'active' } })
      .returning();
    if (!row) throw new Error('source calendar upsert returned no row');
    active.push(row);
    const previous = before.get(providerCalendarId);
    if (previous && previous.state === 'active') continue;
    await feeds.ensurePassthroughPublication(tx, row, account);
    woken.push(await ensureTarget(tx, account, 'events', row.id));
    if (capabilities.push) woken.push(await ensureTarget(tx, account, 'push_renew', row.id));
  }
  await wakeTargets(tx, woken);

  if (sweep) {
    const seen = new Set(listed.map((info) => info.providerCalendarId));
    for (const calendar of before.values()) {
      if (calendar.state === 'gone' || seen.has(calendar.providerCalendarId)) continue;
      await tx.update(sourceCalendar).set({ state: 'gone' }).where(eq(sourceCalendar.id, calendar.id));
      await feeds.onCalendarGone(tx, calendar.id);
      await tx.delete(syncTarget).where(and(eq(syncTarget.targetId, calendar.id), inArray(syncTarget.kind, ['events', 'push_renew'])));
      // Its channels expire on their own; their notifications find no lease.
      await tx.delete(pushLease).where(and(eq(pushLease.target, 'calendar'), eq(pushLease.targetId, calendar.id)));
    }
  }
  return active;
}

/** Runs one `discover` job: list the account's calendars and apply the listing. */
export async function runDiscover(deps: SyncDeps, job: TenantJob, signal: AbortSignal): Promise<JobResult> {
  const [account] = await withTenant(job.tenantId, (tx) => tx.select().from(calendarAccount).where(eq(calendarAccount.id, job.target as CalendarAccount['id'])));
  if (!account) throw new StopTargetError('the account is gone');
  return withAccount(deps, job, account, signal, async (adapter, ctx) => {
    const infos = await adapter.listCalendars(ctx);
    signal.throwIfAborted();
    await fenced(job, (tx) => applyListing(tx, deps.feeds, account, infos, { sweep: true }));
    return { nextRunInMs: DISCOVER_EVERY_MS };
  });
}
