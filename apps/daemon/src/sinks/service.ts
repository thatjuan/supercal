/**
 * Creating, reading and removing sinks for the API (architecture §11). Creation keeps the strict
 * order loop prevention needs (ingest FINDINGS §6):
 *
 * 1. `calendars.insert` the sink calendar (named after the publication, in the primary calendar's zone);
 * 2. at once insert the `sink` row with the Google `sub` and calendar id, so discovery on every
 *    account of that identity skips the calendar from then on (its description also carries the
 *    managed marker, which keeps it out once the row is gone);
 * 3. create its `sink` target with cursor `{ epoch: null, seq: '0' }`, which writes the events.
 *
 * Without the `calendar.app.created` grant, creation answers 409 `needs-consent` with the
 * incremental-consent URL; the account keeps working read-only meanwhile.
 */
import {
  calendarAccount,
  feed,
  publication,
  publicationSource,
  publicationState,
  sink,
  sinkEvent,
  sourceCalendar,
  syncTarget,
  withTenant,
  type AccountId,
  type CalendarAccount,
  type PublicationId,
  type Sink,
  type SinkId,
  type SyncTarget,
  type TenantTx,
} from '@supercal/db';
import { AuthFailedError, type AdapterContext } from '@supercal/providers';
import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import { audit } from '../api/kit/audit.ts';
import { BadRequest, Conflict, Forbidden, NotFound, ProblemError, Unprocessable, type Problem } from '../api/kit/problem.ts';
import { canManageOwned, hasRole } from '../auth/policy.ts';
import type { Principal } from '../auth/principal.ts';
import type { OAuthDeps } from '../oauth/common.ts';
import { startGoogleFlow } from '../oauth/google.ts';
import { accountContext, type SyncDeps } from '../sync/context.ts';
import { wakeTargets } from '../sync/scheduler.ts';
import { INITIAL_SINK_CURSOR, SINK_SCOPE, SinkCursor, type GoogleSinkClient } from './google.ts';

/** 409 `needs-consent`: the account has not granted the sink scope yet; send the browser to `authorizationUrl`. */
export class NeedsConsent extends ProblemError {
  constructor(readonly authorizationUrl: string) {
    super(409, 'Mirroring needs permission to create a calendar in this Google account', undefined, 'needs-consent');
  }

  override toProblem(instance: string): Problem & { authorizationUrl: string } {
    return { ...super.toProblem(instance), authorizationUrl: this.authorizationUrl };
  }
}

/** What the API shows for a sink: its state, derived from the sink, its account and its target. */
export type SinkView = {
  id: SinkId;
  publicationId: PublicationId;
  accountId: AccountId;
  calendarId: string;
  status: 'syncing' | 'up_to_date' | 'error' | 'calendar_missing';
  lastWriteAt: string | null;
  error: string | null;
  counts: { events: number };
  createdAt: string;
};

type SinkRow = { sink: Sink; account: CalendarAccount; epoch: number; target: SyncTarget | null };

async function sinkRows(tx: TenantTx, principal: Principal, where?: SQL): Promise<SinkRow[]> {
  const own = hasRole(principal, 'admin') ? undefined : eq(calendarAccount.ownerUserId, principal.userId);
  return tx
    .select({ sink, account: calendarAccount, epoch: publication.epoch, target: syncTarget })
    .from(sink)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sink.accountId))
    .innerJoin(publication, eq(publication.id, sink.publicationId))
    .leftJoin(syncTarget, and(eq(syncTarget.kind, 'sink'), eq(syncTarget.targetId, sink.id)))
    .where(and(own, where))
    .orderBy(asc(sink.createdAt), asc(sink.id));
}

async function toView(tx: TenantTx, { sink: row, account, epoch, target }: SinkRow): Promise<SinkView> {
  const [ledger] = await tx.select({ events: count() }).from(sinkEvent).where(eq(sinkEvent.sinkId, row.id));
  const sources = await tx.select({ id: publicationSource.sourceCalendarId }).from(publicationSource).where(eq(publicationSource.publicationId, row.publicationId));
  const { maxSeq } = await publicationState(tx, sources.map((s) => s.id));
  const cursor = SinkCursor.safeParse(target?.cursor).data ?? INITIAL_SINK_CURSOR;
  const error = account.status === 'active' ? (target?.lastError ?? null) : (account.statusDetail ?? `The account is ${account.status}`);
  const caughtUp = cursor.epoch === epoch && BigInt(cursor.seq) >= maxSeq;
  return {
    id: row.id,
    publicationId: row.publicationId,
    accountId: row.accountId,
    calendarId: row.providerCalendarId,
    status: row.status === 'calendar_missing' ? 'calendar_missing' : error ? 'error' : caughtUp ? 'up_to_date' : 'syncing',
    lastWriteAt: row.lastWriteAt?.toISOString() ?? null,
    error,
    counts: { events: ledger?.events ?? 0 },
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSinks(principal: Principal): Promise<SinkView[]> {
  return withTenant(principal.tenantId, async (tx) => Promise.all((await sinkRows(tx, principal)).map((row) => toView(tx, row))));
}

export async function getSink(principal: Principal, id: SinkId): Promise<SinkView> {
  return withTenant(principal.tenantId, async (tx) => {
    const [row] = await sinkRows(tx, principal, eq(sink.id, id));
    if (!row) throw new NotFound('No such sink');
    return toView(tx, row);
  });
}

function googleSinks(deps: SyncDeps): GoogleSinkClient {
  if (!deps.googleSinks) throw new Unprocessable('Google is not enabled on this server (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)', 'unsupported-provider');
  return deps.googleSinks;
}

/**
 * Checks a new sink of `publicationId` on `accountId`: both exist and the principal manages them,
 * the account is a Google account of the feed's owner, no such sink exists yet, and the publication
 * reads no sink calendar of the same Google identity (no cycles).
 */
async function validate(tx: TenantTx, principal: Principal, publicationId: PublicationId, accountId: AccountId) {
  const [pub] = await tx
    .select({ name: publication.name, ownerUserId: feed.ownerUserId })
    .from(publication)
    .innerJoin(feed, eq(feed.id, publication.feedId))
    .where(eq(publication.id, publicationId));
  if (!pub) throw new BadRequest([{ path: 'publicationId', message: 'unknown publication' }], 'No such publication');
  if (!canManageOwned(principal, pub.ownerUserId)) throw new Forbidden('You can only mirror your own publications');
  const [account] = await tx.select().from(calendarAccount).where(eq(calendarAccount.id, accountId));
  if (!account || account.ownerUserId !== pub.ownerUserId)
    throw new BadRequest([{ path: 'accountId', message: 'not an account of the publication’s owner' }], 'No such account of the publication’s owner');
  if (account.provider !== 'google' || !account.providerSubject) throw new BadRequest([{ path: 'accountId', message: 'not a Google account' }], 'Sinks write to Google accounts only');

  const [existing] = await tx.select({ id: sink.id }).from(sink).where(and(eq(sink.publicationId, publicationId), eq(sink.accountId, accountId)));
  if (existing) throw new Conflict(`This publication is already mirrored to this account (${existing.id})`);
  const [cycle] = await tx
    .select({ id: sourceCalendar.id })
    .from(publicationSource)
    .innerJoin(sourceCalendar, eq(sourceCalendar.id, publicationSource.sourceCalendarId))
    .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
    .innerJoin(
      sink,
      and(eq(sink.provider, 'google'), eq(sink.providerSubject, calendarAccount.providerSubject), eq(sink.providerCalendarId, sourceCalendar.providerCalendarId)),
    )
    .where(and(eq(publicationSource.publicationId, publicationId), eq(calendarAccount.provider, 'google'), eq(calendarAccount.providerSubject, account.providerSubject)));
  if (cycle) throw new Unprocessable(`The publication reads calendar ${cycle.id}, which a sink of this Google account writes`, 'sink-cycle');
  return { name: pub.name, account };
}

/** The URL that grants the sink scope to `account` by incremental consent, as a `NeedsConsent` to throw. */
const needsConsent = async (oauth: OAuthDeps, principal: Principal, account: CalendarAccount, returnTo: string) =>
  new NeedsConsent(await startGoogleFlow(oauth, principal, returnTo, account.email, { accountId: account.id, scopes: [SINK_SCOPE] }));

/** The account's context when it holds the sink scope; otherwise `NeedsConsent`. */
async function consentedContext(deps: SyncDeps, oauth: OAuthDeps, principal: Principal, account: CalendarAccount, returnTo: string): Promise<AdapterContext> {
  const ctx = account.status === 'reauth_required' ? null : await accountContext(deps, account, AbortSignal.timeout(30_000)).catch(() => null);
  if (!ctx || ctx.credentials.provider !== 'google' || !ctx.credentials.scopes.includes(SINK_SCOPE)) throw await needsConsent(oauth, principal, account, returnTo);
  return ctx;
}

const unavailable = (error: unknown): never => {
  if (error instanceof ProblemError) throw error;
  throw new ProblemError(503, `Google did not answer: ${error instanceof Error ? error.message : String(error)}`);
};

/** Creates a sink in the strict order above and wakes its target. `returnTo` is where consent sends the browser back. */
export async function createSink(
  deps: SyncDeps,
  oauth: OAuthDeps,
  principal: Principal,
  input: { publicationId: PublicationId; accountId: AccountId; returnTo: string },
): Promise<SinkView> {
  const client = googleSinks(deps);
  const { name, account } = await withTenant(principal.tenantId, (tx) => validate(tx, principal, input.publicationId, input.accountId));
  const ctx = await consentedContext(deps, oauth, principal, account, input.returnTo);

  let calendarId: string;
  let timeZone: string;
  try {
    timeZone = await client.primaryTimeZone(ctx);
    calendarId = await client.createCalendar(ctx, name, timeZone);
  } catch (error) {
    if (error instanceof AuthFailedError) throw await needsConsent(oauth, principal, account, input.returnTo);
    return unavailable(error);
  }

  try {
    return await withTenant(principal.tenantId, async (tx) => {
      // Validated again in this transaction, so a concurrent create cannot add a second sink.
      await validate(tx, principal, input.publicationId, input.accountId);
      const [row] = await tx
        .insert(sink)
        .values({ tenantId: principal.tenantId, publicationId: input.publicationId, accountId: account.id, provider: 'google', providerSubject: account.providerSubject, providerCalendarId: calendarId, timeZone })
        .returning();
      if (!row) throw new Error('sink insert returned no row');
      const [target] = await tx
        .insert(syncTarget)
        .values({ tenantId: principal.tenantId, kind: 'sink', targetId: row.id, cursor: INITIAL_SINK_CURSOR, nextRunAt: sql`clock_timestamp()` })
        .returning({ id: syncTarget.id });
      if (target) await wakeTargets(tx, [target.id]);
      await audit(tx, principal, 'sink.create', { type: 'sink', id: row.id }, { publicationId: row.publicationId, accountId: row.accountId, calendarId });
      const [created] = await sinkRows(tx, principal, eq(sink.id, row.id));
      if (!created) throw new Error('created sink not found');
      return toView(tx, created);
    });
  } catch (error) {
    // Nothing references the new calendar, so it would otherwise be orphaned.
    await client.deleteCalendar(ctx, calendarId).catch((e: unknown) => deps.log.warn('could not delete an orphaned sink calendar', { calendarId, error: e }));
    throw error;
  }
}

/**
 * Removes a sink and its target. With `deleteCalendar`, the Google calendar is deleted first: if
 * that fails nothing is removed, so the user can retry. Without it the calendar stays in Google,
 * no longer updated; its managed marker keeps discovery from ingesting it.
 */
export async function deleteSink(deps: SyncDeps, principal: Principal, id: SinkId, { deleteCalendar }: { deleteCalendar: boolean }): Promise<void> {
  const row = await withTenant(principal.tenantId, async (tx) => {
    const [found] = await sinkRows(tx, principal, eq(sink.id, id));
    if (!found) throw new NotFound('No such sink');
    return found;
  });
  if (deleteCalendar) {
    try {
      await googleSinks(deps).deleteCalendar(await accountContext(deps, row.account, AbortSignal.timeout(30_000)), row.sink.providerCalendarId);
    } catch (error) {
      unavailable(error);
    }
  }
  await withTenant(principal.tenantId, async (tx) => {
    await tx.delete(syncTarget).where(and(eq(syncTarget.kind, 'sink'), eq(syncTarget.targetId, id)));
    await tx.delete(sink).where(eq(sink.id, id));
    await audit(tx, principal, 'sink.delete', { type: 'sink', id }, { publicationId: row.sink.publicationId, accountId: row.sink.accountId, deleteCalendar });
  });
}
