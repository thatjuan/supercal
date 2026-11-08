/**
 * The Google Calendar adapter (architecture §8, ingest FINDINGS §4).
 *
 * - Discovery: `calendarList.list`, every page. Sink calendars are returned too; discovery skips them.
 * - Events: `events.list` with `singleEvents=false&showDeleted=true&maxResults=2500` and no other
 *   filter, ever (filters are incompatible with sync tokens). Without a cursor every page is read as
 *   a snapshot; with one, the sync token gives a delta. Only the last page has `nextSyncToken`, so
 *   only `end` carries the cursor. A 410 GONE drops the token and restarts as a snapshot.
 * - Raw objects are the event JSON, grouped by `iCalUID` (exceptions share their master's). A
 *   cancelled event without `recurringEventId` (a deleted single event or master) is a delete; a
 *   cancelled instance is an upsert the normaliser turns into an EXDATE.
 * - Push: `events.watch` per calendar and `calendarList.watch` for discovery, when enabled.
 */
import { z } from 'zod';
import type { AdapterContext, JsonValue, ProviderAdapter, PushLeaseInfo, PushRequest, RawObject, SyncEnd, SyncPage } from '../adapter.ts';
import { ProviderUnavailableError } from '../adapter.ts';
import { createGoogleApi, GoogleHttpError, type GoogleClientOptions } from './api.ts';

const CalendarList = z.object({
  items: z.array(z.object({ id: z.string(), summary: z.string().optional(), summaryOverride: z.string().optional(), backgroundColor: z.string().optional(), timeZone: z.string().optional() })).default([]),
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

const calendarPath = (id: string) => `/calendars/${encodeURIComponent(id)}`;

export function createGoogleAdapter(options: GoogleAdapterOptions): ProviderAdapter<GoogleCursor> {
  const api = createGoogleApi(options);

  async function watch(ctx: AdapterContext, request: PushRequest): Promise<PushLeaseInfo> {
    const path = request.target === 'calendar-list' ? '/users/me/calendarList/watch' : `${calendarPath(request.providerTargetId)}/events/watch`;
    const channel = await api.call(ctx, Channel, path, {
      method: 'POST',
      body: { id: crypto.randomUUID(), type: 'web_hook', address: request.address, token: request.token },
    });
    return {
      target: request.target,
      targetId: request.targetId,
      providerChannelId: channel.id,
      providerResourceId: channel.resourceId,
      expiresAt: new Date(channel.expiration),
      providerState: null,
    };
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
        for (const item of page.items)
          calendars.push({
            providerCalendarId: item.id,
            name: item.summaryOverride ?? item.summary ?? item.id,
            color: item.backgroundColor ?? null,
            timezone: item.timeZone ?? null,
            capabilities: { incremental: 'delta', push: options.push },
          });
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

      async function toPage(items: JsonValue[]): Promise<SyncPage> {
        const heads = items.map((payload) => ({ head: EventHead.parse(payload), payload }));
        for (const { head } of heads) if (!head.recurringEventId && head.iCalUID) masterUids.set(head.id, head.iCalUID);
        const page: SyncPage = { kind: 'page', upserts: [], deletes: [] };
        for (const { head, payload } of heads) {
          if (head.status === 'cancelled' && !head.recurringEventId) {
            page.deletes.push(head.id);
            continue;
          }
          const groupUid = head.iCalUID ?? (head.recurringEventId ? await masterUid(head.recurringEventId) : `${head.id}@google.com`);
          // An instance of a master Google no longer has: nothing to attach it to.
          if (!groupUid) continue;
          const originalStart = head.originalStartTime?.dateTime ?? head.originalStartTime?.date;
          const object: RawObject = { id: head.id, etag: head.etag ?? '', groupUid, payload, ...(originalStart && { originalStart }) };
          page.upserts.push(object);
        }
        return page;
      }

      let syncToken = GoogleCursor.safeParse(cursor).data?.syncToken ?? null;
      for (;;) {
        const seen = new Set<string>();
        let pageToken: string | undefined;
        try {
          for (;;) {
            const query = { singleEvents: 'false', showDeleted: 'true', maxResults: '2500', ...(syncToken && { syncToken }), ...(pageToken && { pageToken }) };
            const page = await api.call(ctx, EventsPage, path, { query });
            yield await toPage(page.items);
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
