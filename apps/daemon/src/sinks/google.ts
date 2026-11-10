/**
 * Google sinks (architecture §11): the Google calls a sink makes (`createGoogleSinkClient`) and the
 * runner for `sync_target` kind `sink` (`runGoogleSink`).
 *
 * A run reads the publication's epoch and its sources' `seq`. When the epoch changed (or the cursor
 * is fresh) it reconciles fully: projects every resource, writes each object whose revision differs
 * from `sink_event.applied_revision`, and deletes ledger entries whose UID is gone. Otherwise it
 * reads `changesSince(cursor.seq)` page by page and projects only those UIDs. The ledger is the
 * durable progress: when the write budget runs out the run stops (cursor unchanged for the page in
 * hand) and the next run skips everything already applied.
 *
 * Every write is `sendUpdates=none` and carries no attendees, organizer or conference request
 * (`payload.ts`). A 404 on a write means the user deleted the calendar: the sink becomes
 * `calendar_missing` and stops.
 */
import { outputUidFor, type ProjectedObject } from '@supercal/core';
import {
  calendarAccount,
  changesSince,
  publication,
  publicationState,
  resourcesByUids,
  resourcesIn,
  sink,
  sinkEvent,
  syncTarget,
  withTenant,
  type CalendarAccount,
  type SecretBox,
  type Sink,
  type SinkEvent,
  type SinkId,
  type TenantTx,
} from '@supercal/db';
import { createGoogleApi, GoogleHttpError, ProviderThrottledError, SINK_CALENDAR_MARKER, type AdapterContext, type GoogleClientOptions } from '@supercal/providers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadAccount as loadFeedAccount, projectRows, type Pub } from '../dav/store.ts';
import { metrics } from '../ops/metrics.ts';
import { withAccount, type SyncDeps, type TenantJob } from '../sync/context.ts';
import { fenced } from '../sync/runner.ts';
import { StopTargetError, type JobResult } from '../sync/scheduler.ts';
import { googleEvents, type SinkEventBody } from './payload.ts';

/** The scope sinks add by incremental consent: create calendars, and manage only those. */
export const SINK_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const SINK_DESCRIPTION = `${SINK_CALENDAR_MARKER}: changes here are overwritten`;

const MINUTE = 60_000;
/** Safety poll; bus `change` notifications wake sinks sooner. */
export const SINK_POLL_MS = 10 * MINUTE;
/** Budget waits up to this long are slept through; longer ones end the run and reschedule it. */
const SHORT_WAIT_MS = 1000;
const PAGE = 500;

/** The sink's position in the change log: the publication epoch it last fully reconciled, and the seq it has applied. */
export const SinkCursor = z.object({ epoch: z.int().nullable(), seq: z.string().regex(/^\d+$/) });
export type SinkCursor = z.infer<typeof SinkCursor>;
export const INITIAL_SINK_CURSOR: SinkCursor = { epoch: null, seq: '0' };

/** A write found the sink's calendar gone (the user deleted it in Google). */
export class CalendarMissingError extends Error {
  override readonly name = 'CalendarMissingError';
}

const calendarPath = (id: string) => `/calendars/${encodeURIComponent(id)}`;
const NO_MAIL = { sendUpdates: 'none' };
const isGone = (error: unknown) => error instanceof GoogleHttpError && (error.status === 404 || error.status === 410);

export type GoogleSinkClient = ReturnType<typeof createGoogleSinkClient>;

/** The Google calls of a sink, for one OAuth client. Errors follow the adapter contract (`createGoogleApi`). */
export function createGoogleSinkClient(options: GoogleClientOptions) {
  const api = createGoogleApi(options);
  const missing = (calendarId: string) => (error: unknown) => {
    throw isGone(error) ? new CalendarMissingError(`Google calendar ${calendarId} is gone`) : error;
  };

  return {
    /** The zone of the user's primary calendar. */
    async primaryTimeZone(ctx: AdapterContext): Promise<string> {
      const primary = await api.call(ctx, z.object({ timeZone: z.string().optional() }), '/users/me/calendarList/primary');
      return primary.timeZone ?? 'UTC';
    },

    /** Creates the sink's secondary calendar and returns its id. */
    async createCalendar(ctx: AdapterContext, summary: string, timeZone: string): Promise<string> {
      const created = await api.call(ctx, z.object({ id: z.string() }), '/calendars', { method: 'POST', body: { summary, description: SINK_DESCRIPTION, timeZone } });
      return created.id;
    },

    /** Deletes the calendar; one that is already gone counts as deleted. */
    async deleteCalendar(ctx: AdapterContext, calendarId: string): Promise<void> {
      await api.call(ctx, z.unknown(), calendarPath(calendarId), { method: 'DELETE' }).catch((error: unknown) => {
        if (!isGone(error)) throw error;
      });
    },

    /**
     * Writes `event`: an update when it is `known` to exist, else an insert. An insert answered 409
     * already exists (a retry after a lost response), so it becomes an update; an update answered
     * 404 was never stored, so it becomes an insert. Any other 404 throws `CalendarMissingError`.
     */
    async writeEvent(ctx: AdapterContext, calendarId: string, event: SinkEventBody, known: boolean): Promise<void> {
      const events = `${calendarPath(calendarId)}/events`;
      const insert = () => api.call(ctx, z.unknown(), events, { method: 'POST', query: NO_MAIL, body: event });
      const update = () => api.call(ctx, z.unknown(), `${events}/${encodeURIComponent(event.id)}`, { method: 'PUT', query: NO_MAIL, body: event });
      try {
        await (known ? update() : insert());
      } catch (error) {
        if (!(error instanceof GoogleHttpError)) throw error;
        if (!known && error.status === 409) await update().catch(missing(calendarId));
        else if (known && isGone(error)) await insert().catch(missing(calendarId));
        else missing(calendarId)(error);
      }
    },

    /** Deletes one event; a 404 or 410 counts as deleted. */
    async deleteEvent(ctx: AdapterContext, calendarId: string, eventId: string): Promise<void> {
      await api.call(ctx, z.unknown(), `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', query: NO_MAIL }).catch((error: unknown) => {
        if (!isGone(error)) throw error;
      });
    },
  };
}

type Loaded = { sink: Sink; account: CalendarAccount; epoch: number; pub: Pub | null; cursor: SinkCursor };

/** The sink with its account, its publication (null while disabled: nothing is published) and its cursor. */
async function load(tx: TenantTx, secrets: SecretBox, id: SinkId): Promise<Loaded | null> {
  const [row] = await tx
    .select({ sink, account: calendarAccount, feedId: publication.feedId, epoch: publication.epoch, cursor: syncTarget.cursor })
    .from(sink)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sink.accountId))
    .innerJoin(publication, eq(publication.id, sink.publicationId))
    .leftJoin(syncTarget, and(eq(syncTarget.kind, 'sink'), eq(syncTarget.targetId, sink.id)))
    .where(eq(sink.id, id));
  if (!row) return null;
  const feed = await loadFeedAccount(tx, secrets, row.feedId);
  const pub = feed?.publications.find((p) => p.id === row.sink.publicationId) ?? null;
  return { sink: row.sink, account: row.account, epoch: row.epoch, pub, cursor: SinkCursor.safeParse(row.cursor).data ?? INITIAL_SINK_CURSOR };
}

/** What one pass writes: objects to upsert, ledger UIDs to delete, and the cursor once it is all applied. */
type Plan = { objects: ProjectedObject[]; gone: SinkEvent[]; ledger: Map<string, SinkEvent>; next: SinkCursor; more: boolean };

function planOf(objects: ProjectedObject[], ledger: SinkEvent[], next: SinkCursor, more: boolean): Plan {
  const live = new Set(objects.map((o) => o.outputUid));
  return { objects, ledger: new Map(ledger.map((e) => [e.uid, e])), gone: ledger.filter((e) => !live.has(e.uid)), next, more };
}

/** The next pass: a full reconcile when the epoch moved, else the next page of changes. */
async function plan(tx: TenantTx, { sink: { id }, epoch, pub, cursor }: Loaded): Promise<Plan> {
  const sourceIds = pub?.sourceIds ?? [];
  if (!pub || sourceIds.length === 0) return planOf([], await tx.select().from(sinkEvent).where(eq(sinkEvent.sinkId, id)), { epoch, seq: cursor.seq }, false);

  if (cursor.epoch !== epoch) {
    // The seq first: rows committed after it are replayed by the next incremental pass.
    const { maxSeq } = await publicationState(tx, sourceIds);
    const objects = await projectRows(pub, await resourcesIn(tx, sourceIds));
    return planOf(objects, await tx.select().from(sinkEvent).where(eq(sinkEvent.sinkId, id)), { epoch, seq: maxSeq.toString() }, false);
  }

  const page = await changesSince(tx, sourceIds, BigInt(cursor.seq), PAGE);
  const uids = [...new Set(page.rows.map((r) => r.uid))];
  const next = { epoch, seq: page.maxSeq.toString() };
  if (uids.length === 0) return planOf([], [], next, false);
  const objects = await projectRows(pub, await resourcesByUids(tx, sourceIds, uids));
  const outputUids = await Promise.all(uids.map((uid) => outputUidFor(pub.spec, uid)));
  const ledger = await tx.select().from(sinkEvent).where(and(eq(sinkEvent.sinkId, id), inArray(sinkEvent.uid, outputUids)));
  return planOf(objects, ledger, next, page.hasMore);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** The `outcome` label of a failed write in `supercal_sink_writes_total`. */
const failedWrite = (error: unknown) => (error instanceof CalendarMissingError ? 'calendar_missing' : error instanceof ProviderThrottledError ? 'throttled' : 'error');

/** Runs one `sink` job. */
export async function runGoogleSink(deps: SyncDeps, job: TenantJob, signal: AbortSignal): Promise<JobResult> {
  const client = deps.googleSinks;
  if (!client) throw new StopTargetError('Google is not configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)');
  const loaded = await withTenant(job.tenantId, (tx) => load(tx, deps.secrets, job.target as SinkId));
  if (!loaded) throw new StopTargetError('the sink is gone');
  const { sink: target, account } = loaded;
  if (target.status === 'calendar_missing') throw new StopTargetError('the sink calendar is missing');
  const zone = target.timeZone ?? 'UTC';
  const budgetKey = account.providerSubject ?? account.id;
  let writes = 0;
  const skipped: { sourceUid: string; reason: string }[] = [];

  return withAccount(deps, job, account, signal, async (_adapter, ctx) => {
    /** Waits for a write slot; returns 0 to go ahead, or the wait that ends this run. */
    const slot = async (): Promise<number> => {
      for (;;) {
        const wait = deps.sinkBudget.take(budgetKey);
        if (wait === 0 || wait > SHORT_WAIT_MS) return wait;
        await sleep(wait, signal);
      }
    };

    /** Runs one write or delete against Google and counts it by outcome. A lease lost mid-write counts as nothing. */
    const counted = async (write: () => Promise<void>): Promise<void> => {
      try {
        await write();
      } catch (error) {
        if (!signal.aborted) metrics.sinkWrites.inc({ outcome: failedWrite(error) });
        throw error;
      }
      metrics.sinkWrites.inc({ outcome: 'ok' });
      writes++;
    };

    /** Applies a plan; returns the wait when the budget ran out first. */
    const apply = async (work: Plan): Promise<number> => {
      for (const object of work.objects) {
        let built: ReturnType<typeof googleEvents>;
        try {
          built = googleEvents(target.id, object, zone);
        } catch (error) {
          skipped.push({ sourceUid: object.sourceUid, reason: error instanceof Error ? error.message : String(error) });
          // Remove old full details if a malformed object cannot be mirrored after a downgrade.
          const stale = work.ledger.get(object.outputUid);
          for (const id of stale?.eventIds ?? []) {
            const wait = await slot();
            if (wait) return wait;
            await counted(() => client.deleteEvent(ctx, target.providerCalendarId, id));
          }
          if (stale) await fenced(job, (tx) => tx.delete(sinkEvent).where(and(eq(sinkEvent.sinkId, target.id), eq(sinkEvent.uid, object.outputUid))));
          continue;
        }
        const { revision, events } = built;
        const before = work.ledger.get(object.outputUid);
        if (before?.appliedRevision === revision) continue;
        const known = new Set(before?.eventIds ?? []);
        for (const event of events) {
          const wait = await slot();
          if (wait) return wait;
          await counted(() => client.writeEvent(ctx, target.providerCalendarId, event, known.has(event.id)));
        }
        const ids = events.map((e) => e.id);
        // An override that went away (its occurrence is now an EXDATE, or it was hidden).
        for (const stale of known) {
          if (ids.includes(stale)) continue;
          const wait = await slot();
          if (wait) return wait;
          await counted(() => client.deleteEvent(ctx, target.providerCalendarId, stale));
        }
        const row = { tenantId: job.tenantId, sinkId: target.id, uid: object.outputUid, providerEventId: ids[0] ?? '', eventIds: ids, appliedRevision: revision };
        await fenced(job, (tx) =>
          tx.insert(sinkEvent).values(row).onConflictDoUpdate({ target: [sinkEvent.sinkId, sinkEvent.uid], set: { providerEventId: row.providerEventId, eventIds: ids, appliedRevision: revision } }),
        );
      }
      for (const gone of work.gone) {
        for (const id of gone.eventIds.length > 0 ? gone.eventIds : [gone.providerEventId]) {
          const wait = await slot();
          if (wait) return wait;
          await counted(() => client.deleteEvent(ctx, target.providerCalendarId, id));
        }
        await fenced(job, (tx) => tx.delete(sinkEvent).where(and(eq(sinkEvent.sinkId, target.id), eq(sinkEvent.uid, gone.uid))));
      }
      return 0;
    };

    try {
      let current = loaded;
      for (;;) {
        const work = await withTenant(job.tenantId, (tx) => plan(tx, current));
        const wait = await apply(work);
        if (wait) return { nextRunInMs: wait };
        await fenced(job, (tx) => tx.update(syncTarget).set({ cursor: work.next }).where(eq(syncTarget.id, job.id)));
        if (!work.more) {
          const first = skipped[0];
          const problem = first ? `Could not mirror ${skipped.length} events; first: ${first.sourceUid}: ${first.reason}`.slice(0, 1000) : null;
          await fenced(job, (tx) => tx.update(sink).set({ problem }).where(eq(sink.id, target.id)));
          return { nextRunInMs: SINK_POLL_MS };
        }
        current = { ...current, cursor: work.next };
      }
    } catch (error) {
      if (!(error instanceof CalendarMissingError)) throw error;
      await withTenant(job.tenantId, (tx) => tx.update(sink).set({ status: 'calendar_missing' }).where(eq(sink.id, target.id)));
      throw new StopTargetError(error.message);
    } finally {
      if (writes > 0) await withTenant(job.tenantId, (tx) => tx.update(sink).set({ lastWriteAt: sql`clock_timestamp()` }).where(eq(sink.id, target.id)));
    }
  });
}
