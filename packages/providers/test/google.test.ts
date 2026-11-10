import { z } from 'zod';
/**
 * The Google adapter against a mocked Google: terminal-page pagination, the 410 reset, a failure on
 * page 2 that yields no cursor, sparse cancellations, throttling and token refresh. Ported from
 * the ingest spike's `google-sync.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  AuthFailedError,
  createGoogleAdapter,
  GOOGLE_INVALID_GRANT_DETAIL,
  GOOGLE_EVENTS_WRITE_SCOPE,
  ProviderConflictError,
  ProviderPartialWriteError,
  ProviderWriteRejectedError,
  createGoogleApi,
  StoredGoogleEvent,
  type StoredObject,
  ProviderThrottledError,
  ProviderUnavailableError,
  SINK_CALENDAR_MARKER,
  type AdapterContext,
  type ProviderCredentials,
  type SyncEnd,
  type SyncPage,
} from '../src/index.ts';
import { googleCredentials, mockGoogle, googleEventStore, type MockRequest } from './google-mock.ts';

let mock: ReturnType<typeof mockGoogle> | undefined;
afterEach(() => mock?.stop());

function setup(handle: (req: MockRequest) => Response | Promise<Response>, credentials: ProviderCredentials = googleCredentials()) {
  mock = mockGoogle(handle);
  const saved: ProviderCredentials[] = [];
  const ctx: AdapterContext = {
    fetch: () => Promise.reject(new Error('the Google adapter must not use the guarded transport')),
    credentials,
    async saveCredentials(next) {
      saved.push(next);
      ctx.credentials = next;
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: AbortSignal.timeout(5000),
  };
  return { adapter: createGoogleAdapter({ ...mock.options, push: false }), ctx, saved, requests: mock.requests };
}

const calendar = { id: 'cal_1', providerCalendarId: 'work@example.test', capabilities: { incremental: 'delta', push: false, write: false } };
const eventsPath = '/calendar/v3/calendars/work%40example.test/events';

async function collect(iterable: AsyncIterable<SyncPage | SyncEnd<unknown>>) {
  const items: (SyncPage | SyncEnd<unknown>)[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

const master = { id: 'master', etag: '"1"', iCalUID: 'm@example.test', start: { date: '2026-11-01' }, end: { date: '2026-11-02' }, recurrence: ['RRULE:FREQ=DAILY'] };
const exception = { id: 'master_20261103', etag: '"2"', iCalUID: 'm@example.test', recurringEventId: 'master', originalStartTime: { date: '2026-11-03' }, start: { date: '2026-11-04' }, end: { date: '2026-11-05' } };
const sparse = { id: 'master_20261105', etag: '"3"', status: 'cancelled', recurringEventId: 'master', originalStartTime: { date: '2026-11-05' } };
const deleted = { id: 'gone', etag: '"4"', status: 'cancelled' };

describe('Google adapter', () => {
  test('drains every page; only the final page carries the cursor, and the query never has filters', async () => {
    const { adapter, ctx, requests } = setup((req) =>
      req.query.get('pageToken') ? Response.json({ items: [exception, sparse, deleted], nextSyncToken: 'next' }) : Response.json({ items: [master], nextPageToken: 'p2' }),
    );
    const items = await collect(adapter.sync(ctx, calendar, null));
    expect(items.map((i) => i.kind)).toEqual(['page', 'page', 'end']);
    expect(items[2]).toEqual({ kind: 'end', mode: 'snapshot', cursor: { v: 1, syncToken: 'next' } });
    const [first, second] = items;
    if (first?.kind !== 'page' || second?.kind !== 'page') throw new Error('expected pages');
    expect(first.upserts).toEqual([{ id: 'master', etag: '"1"', groupUid: 'm@example.test', payload: master }]);
    // The sparse cancellation joins its master's group; cancellation of a master deletes its group.
    expect(second.upserts.map((o) => [o.id, o.groupUid, o.originalStart])).toEqual([
      ['master_20261103', 'm@example.test', '2026-11-03'],
      ['master_20261105', 'm@example.test', '2026-11-05'],
    ]);
    expect(second.deletes).toEqual([]);
    expect(second.deleteGroupsOf).toEqual(['gone']);
    for (const req of requests) {
      expect(req.path).toBe(eventsPath);
      expect(Object.fromEntries([...req.query].filter(([k]) => k !== 'pageToken'))).toEqual({ singleEvents: 'false', showDeleted: 'true', maxResults: '2500' });
    }
  });

  test('a sync token gives a delta; an exception without iCalUID looks up its master', async () => {
    const { adapter, ctx, requests } = setup((req) =>
      req.path === `${eventsPath}/master` ? Response.json(master) : Response.json({ items: [sparse], nextSyncToken: 'next' }),
    );
    const items = await collect(adapter.sync(ctx, calendar, { v: 1, syncToken: 'old' }));
    expect(items.at(-1)).toEqual({ kind: 'end', mode: 'delta', cursor: { v: 1, syncToken: 'next' } });
    expect(items[0]?.kind === 'page' && items[0].upserts[0]?.groupUid).toBe('m@example.test');
    expect(requests[0]?.query.get('syncToken')).toBe('old');
  });

  test('410 GONE discards the sync token and restarts as a snapshot in the same run', async () => {
    const { adapter, ctx, requests } = setup((req) =>
      req.query.get('syncToken') === 'expired' ? new Response(null, { status: 410 }) : Response.json({ items: [master], nextSyncToken: 'fresh' }),
    );
    const items = await collect(adapter.sync(ctx, calendar, { v: 1, syncToken: 'expired' }));
    expect(items.map((i) => i.kind)).toEqual(['page', 'end']);
    expect(items[1]).toEqual({ kind: 'end', mode: 'snapshot', cursor: { v: 1, syncToken: 'fresh' } });
    expect(requests.map((r) => r.query.get('syncToken'))).toEqual(['expired', null]);
  });

  test('a failure on page 2 yields no cursor', async () => {
    const { adapter, ctx } = setup((req) => (req.query.get('pageToken') ? new Response(null, { status: 500 }) : Response.json({ items: [master], nextPageToken: 'p2' })));
    const items: string[] = [];
    const run = (async () => {
      for await (const item of adapter.sync(ctx, calendar, { v: 1, syncToken: 'old' })) items.push(item.kind);
    })();
    await expect(run).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(items).toEqual(['page']);
  });

  test('429 and 403 rateLimitExceeded throttle, honouring Retry-After', async () => {
    const { adapter, ctx } = setup(() => new Response(null, { status: 429, headers: { 'retry-after': '7' } }));
    const throttled = await adapter.listCalendars(ctx).catch((error: unknown) => error);
    expect(throttled).toBeInstanceOf(ProviderThrottledError);
    expect(throttled instanceof ProviderThrottledError && throttled.retryAfterMs).toBe(7000);
    mock?.stop();

    const quota = setup(() => Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 }));
    await expect(quota.adapter.listCalendars(quota.ctx)).rejects.toBeInstanceOf(ProviderThrottledError);
  });

  test('lists every calendar page with its colour and zone', async () => {
    const { adapter, ctx } = setup((req) =>
      req.query.get('pageToken')
        ? Response.json({ items: [{ id: 'b', summary: 'B', summaryOverride: 'Mine', timeZone: 'Europe/Paris' }] })
        : Response.json({ items: [{ id: 'a', summary: 'A', backgroundColor: '#123456' }], nextPageToken: 'n' }),
    );
    expect(await adapter.listCalendars(ctx)).toEqual([
      { providerCalendarId: 'a', name: 'A', color: '#123456', timezone: null, capabilities: { incremental: 'delta', push: false, write: false } },
      { providerCalendarId: 'b', name: 'Mine', color: null, timezone: 'Europe/Paris', capabilities: { incremental: 'delta', push: false, write: false } },
    ]);
  });

  test('listing leaves out calendars whose description starts with the managed marker, and only those', async () => {
    const { adapter, ctx } = setup(() =>
      Response.json({
        items: [
          { id: 'mirror', summary: 'Mirror', description: `${SINK_CALENDAR_MARKER}: changes here are overwritten` },
          { id: 'mine', summary: 'Mine', description: `Notes on what ${SINK_CALENDAR_MARKER} does` },
        ],
      }),
    );
    expect((await adapter.listCalendars(ctx)).map((c) => c.providerCalendarId)).toEqual(['mine']);
  });

  test('an expiring access token is refreshed and saved before the call', async () => {
    const { adapter, ctx, saved, requests } = setup(
      (req) => (req.path === '/token' ? Response.json({ access_token: 'access-2', expires_in: 3600 }) : Response.json({ items: [] })),
      googleCredentials('sub-1', { expired: true }),
    );
    await adapter.listCalendars(ctx);
    expect(new URLSearchParams(requests[0]?.body).get('grant_type')).toBe('refresh_token');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1' });
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer access-2');
  });

  test('invalid_grant on refresh fails authentication with the Testing-mode hint', async () => {
    const { adapter, ctx } = setup(() => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 }), googleCredentials('sub-1', { expired: true }));
    const error = await adapter.listCalendars(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthFailedError);
    expect(error instanceof Error && error.message).toBe(GOOGLE_INVALID_GRANT_DETAIL);
  });
});

/** Device-authored recurring group, optionally carrying a single moved occurrence. */
const writeIcs = (summary = 'Master', withOverride = false) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:device@example.test', 'DTSTAMP:20261101T000000Z', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102', `SUMMARY:${summary}`, 'RRULE:FREQ=DAILY;COUNT=10', 'END:VEVENT', ...(withOverride ? ['BEGIN:VEVENT', 'UID:device@example.test', 'DTSTAMP:20261101T000000Z', 'RECURRENCE-ID;VALUE=DATE:20261103', 'DTSTART;VALUE=DATE:20261104', 'DTEND;VALUE=DATE:20261105', 'SUMMARY:Moved', 'END:VEVENT'] : []), 'END:VCALENDAR', ''].join('\r\n');

/** Mock-backed write setup with granular-consent credentials. */
function writeSetup() {
  const store = googleEventStore();
  const credentials = { ...googleCredentials(), scopes: [GOOGLE_EVENTS_WRITE_SCOPE] };
  return { ...setup((req) => store.handle(req) ?? new Response(null, { status: 404 }), credentials), store };
}

/** Keep the full returned payload, just as the daemon stores it. */
function asStored(objects: Awaited<ReturnType<NonNullable<ReturnType<typeof createGoogleAdapter>['writes']>['put']>>['upserts']): StoredObject[] {
  return objects.map((object) => {
    if (object.payload === null) throw new Error('write returned a touch');
    return { id: object.id, etag: object.etag, payload: object.payload, ...(object.originalStart && { originalStart: object.originalStart }) };
  });
}

describe('Google writes', () => {
  test('owner/writer calendars require the write scope; readers stay read-only', async () => {
    const { adapter, ctx } = setup(() => Response.json({ items: ['owner', 'writer', 'reader'].map((accessRole) => ({ id: accessRole, accessRole })) }), { ...googleCredentials(), scopes: [GOOGLE_EVENTS_WRITE_SCOPE] });
    expect((await adapter.listCalendars(ctx)).map((item) => item.capabilities.write)).toEqual([true, true, false]);
    ctx.credentials = { ...googleCredentials(), scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'] };
    expect((await adapter.listCalendars(ctx)).map((item) => item.capabilities.write)).toEqual([false, false, false]);
    await expect(adapter.writes!.put(ctx, calendar, writeIcs(), [])).rejects.toBeInstanceOf(ProviderWriteRejectedError);
  });
  test('imports the client UID, patches only changed fields, reuses sync grouping and deletes the whole series', async () => {
    const { adapter, ctx, store, requests } = writeSetup();
    const created = await adapter.writes!.put(ctx, calendar, writeIcs(), []);
    const first = created.upserts[0]!;
    const event = store.events.get(first.id)!;
    expect(event.iCalUID).toBe('device@example.test');
    expect(requests[0]).toMatchObject({ method: 'POST', path: `${eventsPath}/import` });
    store.events.set(first.id, StoredGoogleEvent.parse({ ...event, conferenceData: { entryPoints: [{ uri: 'https://meet.test' }] }, attachments: [{ fileId: 'file' }], colorId: '5', extendedProperties: { private: { keep: 'yes' } } }));
    const enriched = { ...first, payload: z.json().parse(store.events.get(first.id)) };
    const edited = await adapter.writes!.put(ctx, calendar, writeIcs('Edited', true), asStored([enriched]));
    const patch = requests.find((req) => req.method === 'PATCH');
    expect(JSON.parse(patch!.body)).toEqual({ summary: 'Edited' });
    expect(patch?.headers.get('if-match')).toBe(first.etag);
    expect(store.events.get(first.id)).toMatchObject({ colorId: '5', attachments: [{ fileId: 'file' }], extendedProperties: { private: { keep: 'yes' } } });
    const sync = await collect(adapter.sync(ctx, calendar, null));
    const page = sync[0];
    if (page?.kind !== 'page') throw new Error('page');
    for (const object of edited.upserts) expect(page.upserts).toContainEqual(object);
    const existing = asStored(page.upserts);
    expect(existing).toHaveLength(2);
    expect((await adapter.writes!.put(ctx, calendar, writeIcs('Edited', true), existing)).upserts).toEqual([]);
    const deleted = await adapter.writes!.delete(ctx, calendar, existing);
    expect(deleted.deletes.sort()).toEqual(existing.map((o) => o.id).sort());
    expect(store.events.size).toBe(0);
  });
  test('finds nonstandard instance ids through the bounded instances endpoint', async () => {
    const { adapter, ctx, store, requests } = writeSetup();
    const created = await adapter.writes!.put(ctx, calendar, writeIcs(), []);
    const id = created.upserts[0]!.id;
    store.instanceIds.set(`${id}_20261103`, 'alternate');
    const edited = await adapter.writes!.put(ctx, calendar, writeIcs('Master', true), asStored(created.upserts));
    expect(edited.upserts.at(-1)?.id).toBe('alternate');
    const instances = requests.find((req) => req.path.endsWith('/instances'));
    expect(instances?.query.get('timeMin')).toBe('2026-11-02T00:00:00Z');
    expect(instances?.query.get('timeMax')).toBe('2026-11-04T00:00:00Z');
    expect(requests.at(-1)?.headers.get('if-match')).toMatch(/^"instance-/);
  });
  test('412 midway stops the write and carries the master accepted earlier', async () => {
    const { adapter, ctx, store } = writeSetup();
    const created = await adapter.writes!.put(ctx, calendar, writeIcs('Master', true), []);
    const existing = asStored(created.upserts);
    const instance = existing.find((o) => o.originalStart)!;
    store.events.set(instance.id, StoredGoogleEvent.parse({ ...store.events.get(instance.id), etag: '"concurrent"' }));
    const error = await adapter.writes!.put(ctx, calendar, writeIcs('Changed'), existing).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderPartialWriteError);
    if (!(error instanceof ProviderPartialWriteError)) throw error;
    expect(error.cause).toBeInstanceOf(ProviderConflictError);
    expect(error.partial.upserts).toHaveLength(1);
    expect(error.partial.upserts[0]?.payload).toMatchObject({ summary: 'Changed' });
    expect(store.events.get(instance.id)?.summary).toBe('Moved');
  });
  test.each([403, 400, 404, 410])('write HTTP %s rejects one object without failing authentication', async (status) => {
    const { ctx } = setup(() => Response.json({ error: { message: 'Google detail', errors: [{ reason: 'insufficientPermissions' }] } }, { status }));
    const api = createGoogleApi(mock!.options);
    const error = await api.call(ctx, StoredGoogleEvent, '/test', { method: 'PATCH', forbidden: 'reject' }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderWriteRejectedError);
    expect(error).not.toBeInstanceOf(AuthFailedError);
    if (status === 400) expect(error).toMatchObject({ reason: 'invalid-data', message: 'Google detail' });
  });
});
