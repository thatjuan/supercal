/**
 * The Microsoft adapter against a mocked Graph: changeKey reconciliation (touches without fetches,
 * a changed master refetching its series), cancelled-occurrence resolution, throttling, the
 * per-mailbox request limit, token rotation and subscription renewal.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  AuthFailedError,
  createMicrosoftAdapter,
  ProviderThrottledError,
  ProviderUnavailableError,
  type AdapterContext,
  type MicrosoftCursor,
  type ProviderCredentials,
  type SourceCalendarRef,
  type SyncEnd,
  type SyncPage,
} from '../src/index.ts';
import { microsoftCredentials, mockGraph, singleEvent, weeklySeries } from './graph-mock.ts';

let graph: ReturnType<typeof mockGraph> | undefined;
afterEach(() => graph?.stop());

function setup(credentials: ProviderCredentials = microsoftCredentials(), pageSize?: number) {
  graph = mockGraph(pageSize === undefined ? {} : { pageSize });
  const saved: ProviderCredentials[] = [];
  const ctx: AdapterContext = {
    fetch: () => Promise.reject(new Error('the Microsoft adapter must not use the guarded transport')),
    credentials,
    async saveCredentials(next) {
      saved.push(next);
      ctx.credentials = next;
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: AbortSignal.timeout(5000),
  };
  return { graph, adapter: createMicrosoftAdapter({ ...graph.options, push: true }), ctx, saved };
}

const calendar = (occurrences?: Record<string, Record<string, string>>): SourceCalendarRef => ({
  id: 'cal_1',
  providerCalendarId: 'cal-a',
  capabilities: { incremental: 'reconcile', push: false },
  ...(occurrences && { occurrences: async (masterId: string) => new Map(Object.entries(occurrences[masterId] ?? {})) }),
});

async function sync(adapter: ReturnType<typeof setup>['adapter'], ctx: AdapterContext, ref: SourceCalendarRef, cursor: MicrosoftCursor | null) {
  const pages: SyncPage[] = [];
  let end: SyncEnd<MicrosoftCursor> | undefined;
  for await (const item of adapter.sync(ctx, ref, cursor)) {
    if (item.kind === 'page') pages.push(item);
    else end = item;
  }
  if (!end) throw new Error('no end');
  return { upserts: pages.flatMap((p) => p.upserts), occurrences: pages.flatMap((p) => p.occurrences ?? []), end };
}

const exception = { id: 'ex-1', changeKey: 'xk1', type: 'exception', seriesMasterId: 'series', originalStart: '2026-11-02T17:00:00Z', start: { dateTime: '2026-11-02T19:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-02T20:00:00.0000000', timeZone: 'UTC' } };

describe('Microsoft adapter', () => {
  test('a first run fetches everything; unchanged changeKeys are then touches without a fetch', async () => {
    const { graph, adapter, ctx } = setup(undefined, 1);
    graph.put('cal-a', singleEvent('one', 'k1'));
    graph.put('cal-a', weeklySeries('series', 'sk1', { exceptionOccurrences: [exception] }));

    const first = await sync(adapter, ctx, calendar(), null);
    expect(first.end.mode).toBe('snapshot');
    expect(graph.fetched().sort()).toEqual(['one', 'series']);
    expect(first.upserts.map((o) => [o.id, o.etag, o.groupUid, o.originalStart])).toEqual([
      ['one', 'k1', 'one@example.test', undefined],
      ['series', 'sk1', 'series@example.test', undefined],
      ['ex-1', 'xk1', 'series@example.test', '2026-11-02T17:00:00Z'],
    ]);
    // The exception is its own object, so the master's payload does not repeat it.
    expect(first.upserts[1]?.payload).not.toHaveProperty('exceptionOccurrences');
    expect(first.occurrences).toEqual([{ masterId: 'series', occurrenceId: 'ex-1', originalStart: '2026-11-02T17:00:00Z' }]);
    const listing = graph.requests.find((r) => r.path === '/v1.0/me/calendars/cal-a/events');
    expect(listing?.query.get('$select')).toBe('id,changeKey,type,seriesMasterId');
    expect(listing?.headers.get('prefer')).toBe('outlook.timezone="UTC", IdType="ImmutableId"');
    const master = graph.requests.find((r) => r.path === '/v1.0/me/events/series');
    expect(master?.query.get('$expand')).toStartWith('exceptionOccurrences(');
    expect(master?.query.get('$select')).toContain('cancelledOccurrences');

    graph.requests.length = 0;
    const second = await sync(adapter, ctx, calendar(), first.end.cursor);
    expect(graph.fetched()).toEqual([]);
    expect(second.upserts).toEqual([
      { id: 'one', etag: 'k1', groupUid: 'one@example.test', payload: null },
      { id: 'series', etag: 'sk1', groupUid: 'series@example.test', payload: null },
      { id: 'ex-1', etag: 'xk1', groupUid: 'series@example.test', payload: null },
    ]);
    expect(second.end.cursor).toEqual(first.end.cursor);
  });

  test('a changed master refetches its series; a cursor from another query fetches everything', async () => {
    const { graph, adapter, ctx } = setup();
    graph.put('cal-a', singleEvent('one', 'k1'));
    graph.put('cal-a', weeklySeries('series', 'sk1'));
    const { end } = await sync(adapter, ctx, calendar(), null);

    graph.put('cal-a', weeklySeries('series', 'sk2', { exceptionOccurrences: [exception] }));
    graph.requests.length = 0;
    const changed = await sync(adapter, ctx, calendar(), end.cursor);
    expect(graph.fetched()).toEqual(['series']);
    expect(changed.upserts.filter((o) => o.payload !== null).map((o) => o.id)).toEqual(['series', 'ex-1']);
    expect(changed.end.cursor.items.series).toEqual({ changeKey: 'sk2', uid: 'series@example.test', exceptions: { 'ex-1': 'xk1' } });

    graph.requests.length = 0;
    await sync(adapter, ctx, calendar(), { ...changed.end.cursor, fingerprint: 'old-query' });
    expect(graph.fetched().sort()).toEqual(['one', 'series']);
  });

  test('cancellations resolve through recorded occurrences, then one instances listing; the rest stay unresolved', async () => {
    const { graph, adapter, ctx } = setup();
    graph.put('cal-a', weeklySeries('series', 'sk1', { cancelledOccurrences: ['known', 'listed', 'lost'] }));
    graph.instances.set('series', [
      { id: 'listed', originalStart: '2026-11-16T17:00:00Z' },
      { id: 'other', originalStart: '2026-11-23T17:00:00Z' },
    ]);
    const { upserts, occurrences } = await sync(adapter, ctx, calendar({ series: { known: '2026-11-09T17:00:00Z' } }), null);
    expect(upserts[0]?.payload).toMatchObject({
      '@supercal.cancelled': [
        { id: 'known', originalStart: '2026-11-09T17:00:00Z' },
        { id: 'listed', originalStart: '2026-11-16T17:00:00Z' },
        { id: 'lost', originalStart: null },
      ],
    });
    expect(occurrences.map((o) => o.occurrenceId)).toEqual(['listed', 'other']);
    const instances = graph.requests.filter((r) => r.path === '/v1.0/me/events/series/instances');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.query.get('startDateTime')).toBe('2026-10-25T00:00:00.000Z');

    // Everything known: no instances listing.
    graph.requests.length = 0;
    await sync(adapter, ctx, calendar({ series: { known: 'a', listed: 'b', lost: 'c' } }), null);
    expect(graph.requests.some((r) => r.path.endsWith('/instances'))).toBe(false);
  });

  test('429 and 503 throttle with Retry-After', async () => {
    const { graph, adapter, ctx } = setup();
    graph.state.intercept = () => new Response(null, { status: 429, headers: { 'retry-after': '7' } });
    const throttled = await adapter.listCalendars(ctx).catch((error: unknown) => error);
    expect(throttled).toBeInstanceOf(ProviderThrottledError);
    expect(throttled instanceof ProviderThrottledError && throttled.retryAfterMs).toBe(7000);
    graph.state.intercept = () => new Response(null, { status: 503 });
    await expect(adapter.listCalendars(ctx)).rejects.toBeInstanceOf(ProviderThrottledError);
  });

  test('no more than 4 requests of one mailbox run at once', async () => {
    const { graph, adapter, ctx } = setup();
    for (let i = 0; i < 12; i++) graph.put('cal-a', singleEvent(`e${i}`, 'k'));
    let active = 0;
    let peak = 0;
    graph.state.intercept = async (req) => {
      if (!req.path.startsWith('/v1.0/me/events/')) return undefined;
      peak = Math.max(peak, ++active);
      await Bun.sleep(20);
      active--;
      return undefined;
    };
    await sync(adapter, ctx, calendar(), null);
    expect(graph.fetched()).toHaveLength(12);
    expect(peak).toBe(4);
  });

  test('lists every calendar with its colour, falling back from hexColor to the preset', async () => {
    const { graph, adapter, ctx } = setup(undefined, 1);
    graph.calendars.push({ id: 'a', name: 'Calendar', hexColor: '#123456', color: 'auto' }, { id: 'b', name: 'Team', hexColor: '', color: 'lightTeal' }, { id: 'c', name: 'Plain', hexColor: '', color: 'auto' });
    expect((await adapter.listCalendars(ctx)).map((c) => [c.providerCalendarId, c.name, c.color])).toEqual([
      ['a', 'Calendar', '#123456'],
      ['b', 'Team', '#26a69a'],
      ['c', 'Plain', null],
    ]);
  });

  test('a nextLink to another origin is refused', async () => {
    const { graph, adapter, ctx } = setup();
    graph.state.intercept = () => Response.json({ value: [], '@odata.nextLink': 'https://evil.example/v1.0/me/calendars?$skip=1' });
    await expect(adapter.listCalendars(ctx)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(graph.requests).toHaveLength(1);
  });

  test('refresh tokens rotate and are saved; invalid_grant and interaction_required need reauth', async () => {
    const { graph, adapter, ctx, saved } = setup(microsoftCredentials('tid-1:oid-1', { expired: true }));
    await adapter.listCalendars(ctx);
    const form = new URLSearchParams(graph.requests[0]?.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('scope')).toContain('offline_access');
    expect(saved).toEqual([expect.objectContaining({ accessToken: 'access-refreshed', refreshToken: 'refresh-rotated' })]);
    expect(graph.requests[1]?.headers.get('authorization')).toBe('Bearer access-refreshed');

    for (const error of ['invalid_grant', 'interaction_required']) {
      ctx.credentials = microsoftCredentials('tid-1:oid-1', { expired: true });
      graph.state.token = () => Response.json({ error }, { status: 400 });
      await expect(adapter.listCalendars(ctx)).rejects.toBeInstanceOf(AuthFailedError);
    }
  });

  test('a subscription is per mailbox, extended in place, and recreated when Graph lost it', async () => {
    const { graph, adapter, ctx } = setup();
    const push = adapter.push;
    if (!push) throw new Error('push expected');
    const request = { target: 'account' as const, targetId: 'acc_1', providerTargetId: 'acc_1', address: 'https://supercal.example.test/hooks/microsoft', token: 'secret' };
    const lease = await push.subscribe(ctx, request);
    expect(graph.subscriptions.get(lease.providerChannelId)).toMatchObject({
      resource: '/me/events',
      changeType: 'created,updated,deleted',
      notificationUrl: request.address,
      lifecycleNotificationUrl: `${request.address}/lifecycle`,
      clientState: 'secret',
    });
    expect(lease).toMatchObject({ target: 'account', targetId: 'acc_1' });
    expect((lease.expiresAt.getTime() - Date.now()) / 60_000).toBeCloseTo(10_000, 0);

    const renewed = await push.renew(ctx, lease, request);
    expect(renewed.providerChannelId).toBe(lease.providerChannelId);
    expect(graph.requests.at(-1)?.method).toBe('PATCH');

    graph.subscriptions.clear();
    const recreated = await push.renew(ctx, lease, request);
    expect(recreated.providerChannelId).not.toBe(lease.providerChannelId);
    await push.teardown(ctx, lease);
  });
});
