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
  ProviderThrottledError,
  ProviderUnavailableError,
  type AdapterContext,
  type ProviderCredentials,
  type SyncEnd,
  type SyncPage,
} from '../src/index.ts';
import { googleCredentials, mockGoogle, type MockRequest } from './google-mock.ts';

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

const calendar = { id: 'cal_1', providerCalendarId: 'work@example.test', capabilities: { incremental: 'delta', push: false } };
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
    // The sparse cancellation joins its master's group; the cancelled single event is a delete.
    expect(second.upserts.map((o) => [o.id, o.groupUid, o.originalStart])).toEqual([
      ['master_20261103', 'm@example.test', '2026-11-03'],
      ['master_20261105', 'm@example.test', '2026-11-05'],
    ]);
    expect(second.deletes).toEqual(['gone']);
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
      { providerCalendarId: 'a', name: 'A', color: '#123456', timezone: null, capabilities: { incremental: 'delta', push: false } },
      { providerCalendarId: 'b', name: 'Mine', color: null, timezone: 'Europe/Paris', capabilities: { incremental: 'delta', push: false } },
    ]);
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
