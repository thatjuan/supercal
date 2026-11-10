/**
 * The Microsoft Graph adapter (architecture §8, ingest FINDINGS §5). Graph v1.0 has no unbounded
 * event delta, so every sync is a `snapshot` reconciliation by `changeKey`, and the runner's sweep
 * deletes what is gone:
 *
 * 1. List the calendar's events with only `id,changeKey,type,seriesMasterId`. That returns single
 *    events and series masters; occurrences and exceptions are not listed.
 * 2. Fetch only items whose `changeKey` differs from the cursor's. A series master comes with its
 *    `exceptionOccurrences` and `cancelledOccurrences`; master and exceptions become raw objects
 *    grouped by the master's `iCalUId`. Unchanged items (and their exceptions) are touches.
 * 3. Exceptions, and instances listed in step 4, are recorded as occurrences (`graph_occurrence`).
 * 4. Cancelled occurrence ids are resolved to original starts through those records; ids still
 *    unknown send one `instances` listing over [series start, min(series end, now + 2 y)]. Whatever
 *    stays unresolved is annotated as such on the master, and the normaliser marks it incomplete.
 *    Absence from a window is never read as a cancellation: a moved exception can lie outside it.
 *
 * TODO(verification): https://github.com/thatjuan/supercal/issues/23 must confirm that editing an
 * exception changes its master's `changeKey`; reconciliation relies on it.
 *
 * Push is one subscription per mailbox on `/me/events` (`target = 'account'`), extended in place by
 * PATCH. Calendars report `push: false`: no subscription is made per calendar, and freshness shows
 * whether the mailbox subscription covers them.
 */
import { Temporal } from '@js-temporal/polyfill';
import { graphWriteOps, graphUtcBody, type GraphBody, type GraphWriteOp } from './write.ts';
import { ProviderConflictError, ProviderPartialWriteError, ProviderWriteRejectedError, type StoredObject, type WriteResult, type SourceCalendarRef } from '../adapter.ts';
import { CANCELLED_ANNOTATION, validateObject } from '@supercal/core';
import { z } from 'zod';
import type { AdapterContext, OccurrenceRecord, ProviderAdapter, PushLeaseInfo, PushRequest, RawObject, SourceCalendarInfo, SyncEnd, SyncPage } from '../adapter.ts';
import { createGraphApi, GraphHttpError, microsoftCanWrite, type MicrosoftClientOptions } from './api.ts';

/** Graph keeps a subscription on Outlook events for at most 10,080 minutes. */
const SUBSCRIPTION_MINUTES = 10_000;
const INSTANCE_HORIZON_MS = 2 * 365 * 86_400_000;
const PAGE_SIZE = 50;
/** Items fetched at once; the per-account semaphore still caps requests at 4. */
const FETCH_BATCH = 8;

const LIST_SELECT = 'id,changeKey,type,seriesMasterId';
const EVENT_SELECT = [
  'id',
  'changeKey',
  'iCalUId',
  'type',
  'seriesMasterId',
  'subject',
  'body',
  'location',
  'start',
  'end',
  'isAllDay',
  'isCancelled',
  'originalStart',
  'originalStartTimeZone',
  'originalEndTimeZone',
  'lastModifiedDateTime',
  'showAs',
  'sensitivity',
  'organizer',
  'attendees',
  'onlineMeeting',
  'recurrence',
  'isReminderOn',
  'reminderMinutesBeforeStart',
].join(',');
/** Changes whenever the selected fields do, so stored changeKeys from another query are not trusted. */
const FINGERPRINT = Bun.hash(`${LIST_SELECT}|${EVENT_SELECT}|cancelledOccurrences|exceptionOccurrences`).toString(36);

/** Outlook's preset calendar colours, for calendars without a `hexColor`. */
const PALETTE: Record<string, string> = {
  lightBlue: '#4a90e2',
  lightGreen: '#5cb85c',
  lightOrange: '#f0ad4e',
  lightGray: '#9e9e9e',
  lightYellow: '#f4d03f',
  lightTeal: '#26a69a',
  lightPink: '#e91e63',
  lightBrown: '#8d6e63',
  lightRed: '#e74c3c',
};

const Calendar = z.object({ canEdit: z.boolean().default(false), id: z.string(), name: z.string().nullish(), hexColor: z.string().nullish(), color: z.string().nullish() });
const Head = z.object({ id: z.string(), changeKey: z.string(), type: z.string().nullish() });
/** What routing needs from a fetched event; the payload keeps the whole JSON. */
const Fetched = z.object({
  id: z.string(),
  changeKey: z.string(),
  iCalUId: z.string().nullish(),
  originalStart: z.string().nullish(),
  recurrence: z.object({ range: z.object({ type: z.string(), startDate: z.string(), endDate: z.string().nullish() }) }).nullish(),
  cancelledOccurrences: z.array(z.string()).nullish(),
  exceptionOccurrences: z.array(z.record(z.string(), z.json())).nullish(),
});
const EventJson = z.record(z.string(), z.json());
const Instance = z.object({ id: z.string(), originalStart: z.string().nullish() });
const Subscription = z.object({ id: z.string(), expirationDateTime: z.string() });

/** The stored state of one listed item: its changeKey, group UID and exceptions (id → changeKey), for touches. */
const Item = z.object({ changeKey: z.string(), uid: z.string(), exceptions: z.record(z.string(), z.string()) });
const MicrosoftCursor = z.object({ v: z.literal(1), fingerprint: z.string(), items: z.record(z.string(), Item) });
export type MicrosoftCursor = z.infer<typeof MicrosoftCursor>;
type Item = z.infer<typeof Item>;

export type MicrosoftAdapterOptions = MicrosoftClientOptions & {
  /** Whether the mailbox subscription is used (needs a public https URL); otherwise calendars are polled. */
  push: boolean;
};

const eventPath = (id: string) => `/me/events/${encodeURIComponent(id)}`;

/** The shared sync/write raw representation, including exception recurrence identity. */
function rawEvent(payload: z.infer<typeof EventJson>, groupUid: string): RawObject {
  const head = Fetched.parse(payload);
  const fields = { ...payload };
  delete fields.exceptionOccurrences;
  return { id: head.id, etag: head.changeKey, groupUid, payload: fields, ...(head.originalStart && { originalStart: head.originalStart }) };
}

/** One fetched item: its raw objects, recorded occurrences and cursor entry. */
type Fetch = { objects: RawObject[]; occurrences: OccurrenceRecord[]; item: Item };

export function createMicrosoftAdapter(options: MicrosoftAdapterOptions): ProviderAdapter<MicrosoftCursor> {
  const api = createGraphApi(options);
  const expiry = () => new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();

  const leaseOf = (request: PushRequest, subscription: z.infer<typeof Subscription>): PushLeaseInfo => ({
    target: 'account',
    targetId: request.targetId,
    providerChannelId: subscription.id,
    providerResourceId: null,
    expiresAt: new Date(subscription.expirationDateTime),
    providerState: null,
  });

  async function subscribe(ctx: AdapterContext, request: PushRequest): Promise<PushLeaseInfo> {
    const subscription = await api.call(ctx, Subscription, '/subscriptions', {
      method: 'POST',
      body: {
        changeType: 'created,updated,deleted',
        notificationUrl: request.address,
        lifecycleNotificationUrl: `${request.address}/lifecycle`,
        resource: '/me/events',
        expirationDateTime: expiry(),
        clientState: request.token,
      },
    });
    return leaseOf(request, subscription);
  }

  /** Every instance of a master between its range start and min(range end, now + 2 y): id → original start. */
  async function instanceStarts(ctx: AdapterContext, masterId: string, range: NonNullable<z.infer<typeof Fetched>['recurrence']>['range']): Promise<OccurrenceRecord[]> {
    const horizon = new Date(Date.now() + INSTANCE_HORIZON_MS);
    // A day of margin on both sides covers any series zone.
    const start = new Date(Date.parse(`${range.startDate}T00:00:00Z`) - 86_400_000);
    const endDate = range.type === 'endDate' && range.endDate ? new Date(Date.parse(`${range.endDate}T00:00:00Z`) + 2 * 86_400_000) : horizon;
    const end = endDate < horizon ? endDate : horizon;
    const records: OccurrenceRecord[] = [];
    if (end <= start) return records;
    const query = { startDateTime: start.toISOString(), endDateTime: end.toISOString(), $select: 'id,originalStart,type', $top: '100' };
    for await (const raw of api.list(ctx, `${eventPath(masterId)}/instances`, query)) {
      const instance = Instance.parse(raw);
      if (instance.originalStart) records.push({ masterId, occurrenceId: instance.id, originalStart: instance.originalStart });
    }
    return records;
  }

  /** Fetches a changed single event or series master; null when it was deleted since the listing. */
  async function fetchItem(ctx: AdapterContext, id: string, known: ((masterId: string) => Promise<Map<string, string>>) | undefined): Promise<Fetch | null> {
    const query = { $select: `${EVENT_SELECT},cancelledOccurrences`, $expand: `exceptionOccurrences($select=${EVENT_SELECT})` };
    const json = await api.call(ctx, EventJson, eventPath(id), { query }).catch((error: unknown) => {
      if (error instanceof GraphHttpError && error.status === 404) return null;
      throw error;
    });
    if (!json) return null;
    const event = Fetched.parse(json);
    const uid = event.iCalUId ?? `${event.id}@graph.microsoft.com`;
    // Exceptions are objects of their own.
    const master = { ...json };
    delete master.exceptionOccurrences;
    const exceptions = (event.exceptionOccurrences ?? []).map((payload) => ({ payload, head: Fetched.parse(payload) }));
    const occurrences = exceptions.flatMap(({ head }) => (head.originalStart ? [{ masterId: id, occurrenceId: head.id, originalStart: head.originalStart }] : []));

    const cancelled = event.cancelledOccurrences ?? [];
    if (cancelled.length > 0) {
      const starts = new Map([...((await known?.(id)) ?? []), ...occurrences.map((o) => [o.occurrenceId, o.originalStart] as const)]);
      if (event.recurrence && cancelled.some((c) => !starts.has(c))) {
        for (const record of await instanceStarts(ctx, id, event.recurrence.range)) {
          occurrences.push(record);
          starts.set(record.occurrenceId, record.originalStart);
        }
      }
      master[CANCELLED_ANNOTATION] = cancelled.map((c) => ({ id: c, originalStart: starts.get(c) ?? null }));
    }

    const objects: RawObject[] = [
      rawEvent(master, uid),
      ...exceptions.map(({ payload }) => rawEvent(payload, uid)),
    ];
    return { objects, occurrences, item: { changeKey: event.changeKey, uid, exceptions: Object.fromEntries(exceptions.map(({ head }) => [head.id, head.changeKey])) } };
  }

  /** Graph's event update/delete docs do not promise If-Match enforcement. Compare changeKey
   * first as well as sending If-Match; the GET → mutation still has a short race window.
   * https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0
   */
  async function condition(ctx: AdapterContext, id: string, etag: string) {
    const event = await api.call(ctx, Fetched, eventPath(id), { write: true });
    if (event.changeKey !== etag) throw new ProviderConflictError('Graph event changed; refetch it');
  }

  /** Retry a zone rejection once: UTC instants for timed events, midnight dates for all-day. */
  async function mutate(ctx: AdapterContext, path: string, method: 'POST' | 'PATCH', body: Partial<GraphBody> & { transactionId?: string }, etag?: string) {
    const call = (fields: typeof body) => api.call(ctx, EventJson, path, { method, body: fields, write: true, ...(etag && { ifMatch: etag }) });
    try { return await call(body); }
    catch (error) {
      if (!(error instanceof ProviderWriteRejectedError && error.reason === 'invalid-data' && /time.?zone/i.test(error.message)) || !body.start) throw error;
      return call({ ...body, ...graphUtcBody(body) });
    }
  }

  /** Execute masters, overrides, then cancellations, retaining responses after partial failure. */
  async function execute(ctx: AdapterContext, calendar: SourceCalendarRef, operations: GraphWriteOp[], existing: StoredObject[]): Promise<WriteResult> {
    if (!microsoftCanWrite(ctx) || !calendar.capabilities.write) throw new ProviderWriteRejectedError('read-only', 'Microsoft calendar is read-only');
    const result: WriteResult = { upserts: [], deletes: [], occurrences: [] };
    const storedMaster = existing.find((object) => !z.object({ seriesMasterId: z.string().nullish() }).parse(object.payload).seriesMasterId);
    let masterId = storedMaster?.id ?? '';
    const records = new Map(await calendar.occurrences?.(masterId) ?? []);
    /** Retain a mutation response even if the following series fetch fails. */
    const accepted = (json: z.infer<typeof EventJson>, uid: string) => {
      const previous = result.upserts.find((object) => object.id === json.id) ?? existing.find((object) => object.id === json.id);
      const fields = { ...(previous ? EventJson.parse(previous.payload) : {}), ...json };
      if (json.id === masterId && Array.isArray(fields.cancelledOccurrences)) {
        const old = z.array(z.object({ id: z.string(), originalStart: z.string().nullable() })).parse(fields[CANCELLED_ANNOTATION] ?? []);
        fields[CANCELLED_ANNOTATION] = z.array(z.string()).parse(fields.cancelledOccurrences).map((id) => ({ id, originalStart: records.get(id) ?? old.find((item) => item.id === id)?.originalStart ?? null }));
      }
      const raw = rawEvent(fields, uid);
      result.upserts = [...result.upserts.filter((object) => object.id !== raw.id), raw];
      if (raw.originalStart) records.set(raw.id, raw.originalStart);
      result.occurrences = [...records].map(([occurrenceId, originalStart]) => ({ masterId, occurrenceId, originalStart }));
    };
    const remember = async () => {
      const fetched = await fetchItem(ctx, masterId, async () => records);
      if (!fetched) return;
      result.upserts = fetched.objects;
      result.occurrences = [...records].map(([occurrenceId, originalStart]) => ({ masterId, occurrenceId, originalStart }));
      for (const record of fetched.occurrences) if (!records.has(record.occurrenceId)) result.occurrences.push(record);
      result.deletes = existing.filter((object) => !fetched.objects.some((next) => next.id === object.id)).map((object) => object.id);
    };
    try {
      if (storedMaster && operations[0]?.op === 'instance') await condition(ctx, storedMaster.id, storedMaster.etag);
      for (const operation of operations) {
        if (operation.op === 'create') {
          const json = await mutate(ctx, `/me/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events`, 'POST', { ...operation.body, transactionId: operation.transactionId });
          const event = Fetched.parse(json);
          masterId = event.id;
          accepted(json, event.iCalUId ?? `${event.id}@graph.microsoft.com`);
        } else if (operation.op === 'patch') {
          await condition(ctx, operation.id, operation.etag);
          const json = await mutate(ctx, eventPath(operation.id), 'PATCH', operation.body, operation.etag);
          const event = Fetched.parse(json);
          accepted(json, event.iCalUId ?? `${event.id}@graph.microsoft.com`);
        } else {
          const original = Temporal.Instant.from(operation.originalStart);
          const previous = existing.find((object) => object.originalStart && Temporal.Instant.from(object.originalStart).equals(original));
          let id = previous?.id ?? [...records].find(([, start]) => Temporal.Instant.from(start).equals(original))?.[0];
          if (!id) {
            for await (const raw of api.list(ctx, `${eventPath(masterId)}/instances`, { startDateTime: original.subtract({ hours: 24 }).toString(), endDateTime: original.add({ hours: 24 }).toString() }, true)) {
              const instance = Instance.parse(raw);
              if (instance.originalStart) records.set(instance.id, instance.originalStart);
              if (instance.originalStart && Temporal.Instant.from(instance.originalStart).equals(original)) id = instance.id;
            }
          }
          if (!id) throw new ProviderWriteRejectedError('not-found', 'Graph occurrence no longer exists');
          const current = await api.call(ctx, Fetched, eventPath(id), { write: true });
          const etag = previous?.etag ?? current.changeKey;
          if (current.changeKey !== etag) throw new ProviderConflictError('Graph occurrence changed; refetch it');
          records.set(id, operation.originalStart);
          if (operation.body) {
            const json = await mutate(ctx, eventPath(id), 'PATCH', operation.body, etag);
            const uid = result.upserts[0]?.groupUid ?? Fetched.parse(storedMaster?.payload).iCalUId ?? `${masterId}@graph.microsoft.com`;
            accepted(json, uid);
          } else {
            await api.call(ctx, z.unknown(), eventPath(id), { method: 'DELETE', write: true, ifMatch: etag });
            result.deletes.push(id);
            result.upserts = result.upserts.filter((object) => object.id !== id);
            const master = result.upserts.find((object) => object.id === masterId) ?? (storedMaster ? rawEvent(EventJson.parse(storedMaster.payload), Fetched.parse(storedMaster.payload).iCalUId ?? `${masterId}@graph.microsoft.com`) : undefined);
            if (master) {
              const json = EventJson.parse(master.payload);
              const cancelled = z.array(z.object({ id: z.string(), originalStart: z.string().nullable() })).parse(json[CANCELLED_ANNOTATION] ?? []);
              accepted({ ...json, cancelledOccurrences: [...new Set([...z.array(z.string()).parse(json.cancelledOccurrences ?? []), id])], [CANCELLED_ANNOTATION]: [...cancelled.filter((item) => item.id !== id), { id, originalStart: operation.originalStart }] }, master.groupUid);
            }
            result.occurrences = [...records].map(([occurrenceId, originalStart]) => ({ masterId, occurrenceId, originalStart }));
          }
        }
        // The refreshed master includes Graph's cancellation ids and latest changeKey. Keeping
        // each completed step makes a later exception failure publish exactly what succeeded.
        await remember();
      }
      return result;
    } catch (error) {
      if (result.upserts.length || result.deletes.length) throw new ProviderPartialWriteError(result, error);
      throw error;
    }
  }

  return {
    provider: 'microsoft',
    format: 'graph',
    capabilities: { calendarDiscovery: 'poll', push: options.push ? 'account' : 'none' },

    writes: {
      async put(ctx, calendar, ics, existing) {
        const parsed = validateObject(ics);
        if (!parsed.ok) throw new ProviderWriteRejectedError('invalid-data', parsed.detail);
        let operations;
        try { operations = graphWriteOps(parsed.resource, existing, calendar.timezone ?? 'UTC'); }
        catch (error) {
          if (error instanceof ProviderWriteRejectedError) ctx.log.info('Graph write rejected before requests', { error: error.message });
          throw error;
        }
        return execute(ctx, calendar, operations, existing);
      },
      async delete(ctx, calendar, existing) {
        if (!microsoftCanWrite(ctx) || !calendar.capabilities.write) throw new ProviderWriteRejectedError('read-only', 'Microsoft calendar is read-only');
        const master = existing.find((object) => !z.object({ seriesMasterId: z.string().nullish() }).parse(object.payload).seriesMasterId);
        if (!master) throw new ProviderWriteRejectedError('not-found', 'Graph series no longer exists');
        await condition(ctx, master.id, master.etag);
        await api.call(ctx, z.unknown(), eventPath(master.id), { method: 'DELETE', write: true, ifMatch: master.etag });
        return { upserts: [], deletes: existing.map((object) => object.id) };
      },
    },

    async listCalendars(ctx) {
      const calendars: SourceCalendarInfo[] = [];
      for await (const raw of api.list(ctx, '/me/calendars', { $select: 'id,name,hexColor,color,canEdit', $top: '100' })) {
        const calendar = Calendar.parse(raw);
        calendars.push({
          providerCalendarId: calendar.id,
          name: calendar.name || calendar.id,
          color: calendar.hexColor || PALETTE[calendar.color ?? ''] || null,
          timezone: null,
          capabilities: { incremental: 'reconcile', push: false, write: calendar.canEdit && microsoftCanWrite(ctx) },
        });
      }
      return calendars;
    },

    async *sync(ctx, calendar, cursor): AsyncGenerator<SyncPage | SyncEnd<MicrosoftCursor>> {
      const parsed = MicrosoftCursor.safeParse(cursor);
      const stored = parsed.success && parsed.data.fingerprint === FINGERPRINT ? parsed.data.items : {};
      const heads: z.infer<typeof Head>[] = [];
      const path = `/me/calendars/${encodeURIComponent(calendar.providerCalendarId)}/events`;
      for await (const raw of api.list(ctx, path, { $select: LIST_SELECT, $top: '100' })) {
        const head = Head.parse(raw);
        if (head.type !== 'occurrence' && head.type !== 'exception') heads.push(head);
      }

      const items: Record<string, Item> = {};
      let page: SyncPage = { kind: 'page', upserts: [], deletes: [], occurrences: [] };
      for (let i = 0; i < heads.length; i += FETCH_BATCH) {
        const batch = heads.slice(i, i + FETCH_BATCH);
        const fetched = await Promise.all(batch.map((head) => (stored[head.id]?.changeKey === head.changeKey ? null : fetchItem(ctx, head.id, calendar.occurrences))));
        batch.forEach((head, n) => {
          const unchanged = stored[head.id];
          const result = fetched[n];
          if (result) {
            items[head.id] = result.item;
            page.upserts.push(...result.objects);
            page.occurrences?.push(...result.occurrences);
          } else if (unchanged?.changeKey === head.changeKey) {
            items[head.id] = unchanged;
            const touch = (id: string, etag: string) => page.upserts.push({ id, etag, groupUid: unchanged.uid, payload: null });
            touch(head.id, unchanged.changeKey);
            for (const [id, etag] of Object.entries(unchanged.exceptions)) touch(id, etag);
          }
        });
        if (page.upserts.length >= PAGE_SIZE) {
          yield page;
          page = { kind: 'page', upserts: [], deletes: [], occurrences: [] };
        }
      }
      if (page.upserts.length > 0) yield page;
      yield { kind: 'end', mode: 'snapshot', cursor: { v: 1, fingerprint: FINGERPRINT, items } };
    },

    push: {
      subscribe,
      async renew(ctx, lease, request) {
        const renewed = await api
          .call(ctx, Subscription, `/subscriptions/${encodeURIComponent(lease.providerChannelId)}`, { method: 'PATCH', body: { expirationDateTime: expiry() } })
          .catch((error: unknown) => {
            if (error instanceof GraphHttpError && error.status === 404) return null;
            throw error;
          });
        // Graph removed the subscription: make a new one.
        return renewed ? leaseOf(request, renewed) : subscribe(ctx, request);
      },
      async teardown(ctx, lease) {
        await api.call(ctx, z.unknown(), `/subscriptions/${encodeURIComponent(lease.providerChannelId)}`, { method: 'DELETE' }).catch((error: unknown) => {
          if (!(error instanceof GraphHttpError && error.status === 404)) throw error;
        });
      },
    },
  };
}
