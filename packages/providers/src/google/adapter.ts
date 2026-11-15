/**
 * The Google Calendar adapter (architecture §8, ingest FINDINGS §4).
 *
 * - Discovery: `calendarList.list`, every page, without calendars carrying the managed marker: a sink's
 *   mirror stays out even after its `sink` row is gone (publication or account deleted, reconnect).
 * - Events: `events.list` with `singleEvents=false&showDeleted=true&maxResults=2500` and no other
 *   filter, ever (filters are incompatible with sync tokens). Without a cursor every page is read as
 *   a snapshot; with one, the sync token gives a delta. Only the last page has `nextSyncToken`, so
 *   only `end` carries the cursor. A 410 GONE drops the token and restarts as a snapshot.
 * - Raw objects are the event JSON, grouped by `iCalUID` (exceptions share their master's). A
 *   cancelled event without `recurringEventId` deletes its whole stored group; a
 *   cancelled instance is an upsert the normaliser turns into an EXDATE.
 * - Push: `events.watch` per calendar and `calendarList.watch` for discovery, when enabled.
 */
import { Temporal } from '@js-temporal/polyfill';
import { validateObject } from '@supercal/core';
import { googleWriteOps, googleSlot, googleInstanceId, StoredGoogleEvent, googleSendUpdates, type GoogleWriteOp } from './write.ts';
import { z } from 'zod';
import type { AdapterContext, JsonValue, ProviderAdapter, PushLeaseInfo, PushRequest, RawObject, SyncEnd, SyncPage, StoredObject, WriteResult, SourceCalendarRef } from '../adapter.ts';
import { ProviderUnavailableError, ProviderPartialWriteError, ProviderWriteRejectedError } from '../adapter.ts';
import { createGoogleApi, GoogleHttpError, hasScope, GOOGLE_EVENTS_WRITE_SCOPE, type GoogleClientOptions } from './api.ts';

const CalendarList = z.object({
  items: z
    .array(z.object({ id: z.string(), accessRole: z.string().optional(), summary: z.string().optional(), summaryOverride: z.string().optional(), description: z.string().optional(), backgroundColor: z.string().optional(), timeZone: z.string().optional() }))
    .default([]),
  nextPageToken: z.string().optional(),
});

/** Only the fields routing needs; the payload keeps the whole event. */
const EventHead = z.object({
  id: z.string(),
  etag: z.string().optional(),
  iCalUID: z.string().optional(),
  status: z.string().optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: z.object({ date: z.string().optional(), dateTime: z.string().optional() }).optional(),
});
const EventsPage = z.object({ items: z.array(z.json()).default([]), nextPageToken: z.string().optional(), nextSyncToken: z.string().optional() });
const Channel = z.object({ id: z.string(), resourceId: z.string(), expiration: z.coerce.number() });

const GoogleCursor = z.object({ v: z.literal(1), syncToken: z.string() });
export type GoogleCursor = z.infer<typeof GoogleCursor>;

export type GoogleAdapterOptions = GoogleClientOptions & {
  /** Whether watch channels are used (needs a public https URL); otherwise calendars are polled. */
  push: boolean;
};

/**
 * What the description of a calendar Supercal created starts with. Discovery never ingests such a
 * calendar. It is a recovery hint beside the `sink` row, which stays the authority while it exists
 * (a user can edit a description).
 */
export const SINK_CALENDAR_MARKER = 'Managed by Supercal';

const calendarPath = (id: string) => `/calendars/${encodeURIComponent(id)}`;

/** Route returned Google JSON exactly as sync pages, including sparse cancellations. */
export async function toPage(items: JsonValue[], masterUids: Map<string, string | null>, masterUid: (id: string) => Promise<string | null>): Promise<SyncPage> {
  const heads = items.map((payload) => ({ head: EventHead.parse(payload), payload }));
  for (const { head } of heads) if (!head.recurringEventId && head.iCalUID) masterUids.set(head.id, head.iCalUID);
  const cancelledMasters = new Set(heads.filter(({ head }) => head.status === 'cancelled' && !head.recurringEventId).map(({ head }) => head.id));
  const page: SyncPage = { kind: 'page', upserts: [], deletes: [], deleteGroupsOf: [...cancelledMasters] };
  for (const { head, payload } of heads) {
    if (head.status === 'cancelled' && !head.recurringEventId) {
      continue;
    }
    if (head.recurringEventId && cancelledMasters.has(head.recurringEventId)) continue;
    const groupUid = head.iCalUID ?? (head.recurringEventId ? await masterUid(head.recurringEventId) : `${head.id}@google.com`);
    // An instance of a master Google no longer has: nothing to attach it to.
    if (!groupUid) continue;
    const originalStart = head.originalStartTime?.dateTime ?? head.originalStartTime?.date;
    const object: RawObject = { id: head.id, etag: head.etag ?? '', groupUid, payload, ...(originalStart && { originalStart }) };
    page.upserts.push(object);
  }
  return page;
}

/** A Google adapter whose reads and writes share one account request budget. */
export function createGoogleAdapter(options: GoogleAdapterOptions): ProviderAdapter<GoogleCursor> {
  const api = createGoogleApi(options);

  async function watch(ctx: AdapterContext, request: PushRequest): Promise<PushLeaseInfo | null> {
    const path = request.target === 'calendar-list' ? '/users/me/calendarList/watch' : `${calendarPath(request.providerTargetId)}/events/watch`;
    const channel = await api.call(ctx, Channel, path, {
      method: 'POST',
      body: { id: crypto.randomUUID(), type: 'web_hook', address: request.address, token: request.token },
    }).catch((error: unknown) => {
      // Google's built-in holiday calendars can be read but cannot create watch channels.
      if (request.target === 'calendar' && error instanceof GoogleHttpError && error.status === 400 && error.reason === 'pushNotSupportedForRequestedResource') return null;
      throw error;
    });
    if (!channel) return null;
    return {
      target: request.target,
      targetId: request.targetId,
      providerChannelId: channel.id,
      providerResourceId: channel.resourceId,
      expiresAt: new Date(channel.expiration),
      providerState: null,
    };
  }

  /** Execute a UID group in order and retain every accepted response if a later request fails. */
  async function execute(ctx: AdapterContext, calendar: SourceCalendarRef, operations: GoogleWriteOp[], existing: StoredObject[]): Promise<WriteResult> {
    if (!hasScope(ctx, GOOGLE_EVENTS_WRITE_SCOPE)) throw new ProviderWriteRejectedError('read-only', 'Google account has not granted calendar.events');
    const result: WriteResult = { upserts: [], deletes: [] };
    const path = `${calendarPath(calendar.providerCalendarId)}/events`;
    const masterUids = new Map<string, string | null>();
    for (const object of existing) {
      const event = EventHead.parse(object.payload);
      if (!event.recurringEventId) masterUids.set(event.id, event.iCalUID ?? null);
    }
    let importedId = '';
    try {
      for (const operation of operations) {
        if (operation.op === 'delete') {
          await api.call(ctx, z.unknown(), `${path}/${encodeURIComponent(operation.eventId)}`, { method: 'DELETE', forbidden: 'reject', headers: { 'If-Match': operation.etag }, query: { sendUpdates: operation.sendUpdates } });
          const head = existing.find((object) => object.id === operation.eventId);
          const ids = head && !EventHead.parse(head.payload).recurringEventId ? existing.map((object) => object.id) : [operation.eventId];
          result.deletes.push(...ids);
          continue;
        }
        let payload: JsonValue;
        if (operation.op === 'import') {
          payload = await api.call(ctx, z.json(), `${path}/import`, { method: 'POST', forbidden: 'reject', body: operation.body });
          importedId = EventHead.parse(payload).id;
        } else if (operation.op === 'patch') {
          payload = await api.call(ctx, z.json(), `${path}/${encodeURIComponent(operation.eventId)}`, { method: 'PATCH', forbidden: 'reject', body: operation.body, headers: { 'If-Match': operation.etag }, query: { sendUpdates: operation.sendUpdates } });
        } else {
          const masterId = operation.masterId || importedId;
          const eventId = googleInstanceId(masterId, operation.originalStart);
          /** A newly overridden instance has no stored ETag; a lookup supplies one for the fallback id. */
          const patch = (id: string, etag?: string) => api.call(ctx, z.json(), `${path}/${encodeURIComponent(id)}`, { method: 'PATCH', forbidden: 'reject', body: operation.body, ...(etag && { headers: { 'If-Match': etag } }), query: { sendUpdates: operation.sendUpdates } });
          payload = await patch(eventId).catch(async (error: unknown) => {
            if (!(error instanceof ProviderWriteRejectedError && error.reason === 'not-found')) throw error;
            const key = googleSlot(operation.originalStart);
            const at = key.length === 10 ? Temporal.PlainDate.from(key).toZonedDateTime('UTC').toInstant() : Temporal.Instant.from(key);
            let pageToken: string | undefined;
            do {
              const page = await api.call(ctx, EventsPage, `${path}/${encodeURIComponent(masterId)}/instances`, { forbidden: 'reject', query: { timeMin: at.subtract({ hours: 24 }).toString(), timeMax: at.add({ hours: 24 }).toString(), showDeleted: 'true', ...(pageToken && { pageToken }) } });
              const match = page.items.map((item) => EventHead.parse(item)).find((head) => head.originalStartTime && googleSlot(head.originalStartTime) === key);
              if (match) return patch(match.id, match.etag);
              pageToken = page.nextPageToken;
            } while (pageToken);
            throw new ProviderWriteRejectedError('not-found', 'Google recurrence instance no longer exists');
          });
        }

        const page = await toPage([payload], masterUids, async (id) => masterUids.get(id) ?? null);
        result.upserts.push(...page.upserts);
        result.deletes.push(...page.deletes, ...existing.filter((object) => page.deleteGroupsOf?.includes(object.id)).flatMap(() => existing.map((object) => object.id)));
      }
      return result;
    } catch (error) {
      if (result.upserts.length || result.deletes.length) throw new ProviderPartialWriteError(result, error);
      throw error;
    }
  }

  return {
    provider: 'google',
    format: 'google',
    capabilities: { calendarDiscovery: options.push ? 'push' : 'poll', push: options.push ? 'calendar' : 'none' },

    async listCalendars(ctx) {
      const calendars = [];
      let pageToken: string | undefined;
      do {
        const page = await api.call(ctx, CalendarList, '/users/me/calendarList', { query: { maxResults: '250', ...(pageToken && { pageToken }) } });
        for (const item of page.items) {
          if (item.description?.startsWith(SINK_CALENDAR_MARKER)) continue;
          calendars.push({
            providerCalendarId: item.id,
            name: item.summaryOverride ?? item.summary ?? item.id,
            color: item.backgroundColor ?? null,
            timezone: item.timeZone ?? null,
            capabilities: { incremental: 'delta', push: options.push, write: (item.accessRole === 'owner' || item.accessRole === 'writer') && hasScope(ctx, GOOGLE_EVENTS_WRITE_SCOPE) },
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return calendars;
    },

    async *sync(ctx, calendar, cursor): AsyncGenerator<SyncPage | SyncEnd<GoogleCursor>> {
      const path = `${calendarPath(calendar.providerCalendarId)}/events`;
      const masterUids = new Map<string, string | null>();

      /** The iCalUID of a master, for an exception that arrived without one (sparse cancellations). */
      async function masterUid(masterId: string): Promise<string | null> {
        if (!masterUids.has(masterId)) {
          const master = await api.call(ctx, EventHead, `${path}/${encodeURIComponent(masterId)}`).catch((error: unknown) => {
            if (error instanceof GoogleHttpError && (error.status === 404 || error.status === 410)) return null;
            throw error;
          });
          masterUids.set(masterId, master?.iCalUID ?? null);
        }
        return masterUids.get(masterId) ?? null;
      }

      let syncToken = GoogleCursor.safeParse(cursor).data?.syncToken ?? null;
      for (;;) {
        const seen = new Set<string>();
        let pageToken: string | undefined;
        try {
          for (;;) {
            const query = { singleEvents: 'false', showDeleted: 'true', maxResults: '2500', ...(syncToken && { syncToken }), ...(pageToken && { pageToken }) };
            const page = await api.call(ctx, EventsPage, path, { query });
            yield await toPage(page.items, masterUids, masterUid);
            if (page.nextPageToken) {
              if (seen.has(page.nextPageToken)) throw new ProviderUnavailableError('Google repeated a page token');
              seen.add(page.nextPageToken);
              pageToken = page.nextPageToken;
              continue;
            }
            if (!page.nextSyncToken) throw new ProviderUnavailableError('Google sent no nextSyncToken on the last page');
            yield { kind: 'end', mode: syncToken ? 'delta' : 'snapshot', cursor: { v: 1, syncToken: page.nextSyncToken } };
            return;
          }
        } catch (error) {
          // The sync token expired: a full snapshot, within this run.
          if (error instanceof GoogleHttpError && error.status === 410 && syncToken) {
            ctx.log.info('Google sync token expired; resyncing the calendar', { calendarId: calendar.id });
            syncToken = null;
            continue;
          }
          throw error;
        }
      }
    },

    writes: {
      async put(ctx, calendar, ics, existing) {
        const parsed = validateObject(ics);
        if (!parsed.ok) throw new ProviderWriteRejectedError('invalid-data', parsed.detail);
        return execute(ctx, calendar, googleWriteOps(parsed.resource, existing, calendar.timezone ?? 'UTC'), existing);
      },
      async delete(ctx, calendar, existing) {
        const masters = existing.filter((object) => !EventHead.parse(object.payload).recurringEventId);
        const objects = masters.length ? masters : existing;
        return execute(ctx, calendar, objects.map((object) => {
          const event = StoredGoogleEvent.parse(object.payload);
          return { op: 'delete', eventId: object.id, etag: object.etag, sendUpdates: googleSendUpdates(event, { status: 'cancelled' }) };
        }), existing);
      },
    },

    push: {
      subscribe: watch,
      // A Google channel cannot be extended: renewal is a new channel, overlapping the old one.
      renew: (ctx, _lease, request) => watch(ctx, request),
      async teardown(ctx, lease) {
        await api
          .call(ctx, z.unknown(), '/channels/stop', { method: 'POST', body: { id: lease.providerChannelId, resourceId: lease.providerResourceId } })
          .catch((error: unknown) => {
            if (!(error instanceof GoogleHttpError && error.status === 404)) throw error;
          });
      },
    },
  };
}
