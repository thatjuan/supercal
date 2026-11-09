/**
 * ICS feeds and the subscribe API over a scratch database: conditional requests that skip
 * rendering, HEAD, the combined feed's UID dedupe, 404s for unknown tokens (including rotated
 * ones), the rendered calendar itself, and the token check behind `POST …/subscribe/links`.
 * `BENCH=1` adds the 5,000-event benchmark.
 */
import { addMissingTimezones, normalizeIcal, spanOf, type EventResource } from '@supercal/core';
import {
  calendarAccount,
  closeDb,
  connectDb,
  member,
  migrate,
  organization,
  purgeTombstones,
  changesSince,
  recordChanges,
  sourceCalendar,
  user,
  withTenant,
  withControl,
  type FeedId,
  type ResourceChange,
  type SourceCalendar,
  type SourceCalendarId,
  type TenantId,
} from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import ICAL from 'ical.js';
import { createApi } from '../src/api/index.ts';
import { CreatedCalendarLink } from '../src/api/links.ts';
import type { subscribeLinks } from '../src/api/subscribe.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { createFeedService } from '../src/feeds/service.ts';
import { createIcs } from '../src/ics/index.ts';
import { renderIcs } from '../src/ics/render.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const userId = `user_alice_${crypto.randomUUID().slice(0, 8)}`;
const principal: Principal = { kind: 'user', userId, tenantId, role: 'member', via: 'session', isOperator: false };
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

type SubscribeLinks = ReturnType<typeof subscribeLinks>;

const feeds = createFeedService(testSecrets);
let renders = 0;
const ics = new Hono().route(
  '/ics',
  createIcs({
    secrets: testSecrets,
    cacheBytes: 16 * 1024 * 1024,
    render: (...args) => (renders++, renderIcs(...args)),
  }),
);

let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let api: ReturnType<typeof createApi>;
let feedId: FeedId;
let token: string;
const calendars: Partial<Record<'work' | 'home' | 'big', SourceCalendar>> = {};

const calendar = (name: keyof typeof calendars) => {
  const found = calendars[name];
  if (!found) throw new Error(`no ${name} calendar`);
  return found;
};

/** Generated once: generating a VTIMEZONE per event would dominate the benchmark's setup. */
let berlin: EventResource['timezones'] | undefined;

/** An upsert of a one-hour Berlin-time event, `day` days after 5 January 2026, with its VTIMEZONE as an ical source would carry it. */
function event(sourceCalendarId: SourceCalendarId, uid: string, summary: string, day = 0): ResourceChange {
  const start = new Date(Date.UTC(2026, 0, 5 + day, 9)).toISOString().replace(/[-:]|\.\d+Z$/g, '');
  const payload = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART;TZID=Europe/Berlin:${start}`,
    'DURATION:PT1H',
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const normalized = normalizeIcal([{ id: `${uid}.ics`, etag: '1', groupUid: uid, payload }]);
  berlin ??= addMissingTimezones(normalized.resource).timezones;
  const resource = { ...normalized.resource, timezones: berlin };
  const { completeness } = normalized;
  const span = spanOf(resource, 'Europe/Berlin');
  return {
    op: 'upsert',
    sourceCalendarId,
    uid,
    resource,
    revision: summary,
    sequence: 0,
    lastModified: null,
    organizer: null,
    span: { start: new Date(span.start.epochMilliseconds), end: span.end === 'infinity' ? 'infinity' : new Date(span.end.epochMilliseconds) },
    completeness,
  };
}

const get = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => ics.request(`/ics${path}`, init);
const uidsOf = (text: string) => new ICAL.Component(ICAL.parse(text)).getAllSubcomponents('vevent').map((e) => String(e.getFirstPropertyValue('uid')));

describe.skipIf(!testDatabaseUrl)('ICS feeds', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('ics');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    api = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }, injectPrincipal);

    const db = unsafeDb();
    const now = new Date();
    await db.insert(organization).values({ id: tenantId, name: 'A', slug: tenantId, createdAt: now });
    await db.insert(user).values({ id: userId, name: 'Alice', email: 'alice@example.com', updatedAt: now });
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId, role: 'member', createdAt: now });
    const [account] = await db
      .insert(calendarAccount)
      .values({ tenantId, ownerUserId: userId, provider: 'caldav', displayName: 'Alice', email: 'alice@example.com', autoPublish: false })
      .returning();
    if (!account) throw new Error('account insert failed');
    for (const name of ['work', 'home', 'big'] as const) {
      const [row] = await db
        .insert(sourceCalendar)
        .values({ tenantId, accountId: account.id, providerCalendarId: `/cal/${name}/`, name: `Alice ${name}`, color: '#336699', timezone: 'Europe/Berlin' })
        .returning();
      if (!row) throw new Error('calendar insert failed');
      calendars[name] = row;
    }

    await withTenant(tenantId, async (tx) => {
      const created = await feeds.createFeed(tx, principal, 'Alice’s feed');
      feedId = created.feed.id;
      token = created.secrets.ics.token;
      for (const name of ['work', 'home'] as const) await feeds.createPublication(tx, principal, created.feed.id, { kind: 'passthrough', sourceCalendarId: calendar(name).id });
      await recordChanges(tx, [
        event(calendar('work').id, 'a@example.com', 'Planning'),
        event(calendar('work').id, 'shared@example.com', 'All hands'),
        event(calendar('home').id, 'shared@example.com', 'All hands'),
        event(calendar('home').id, 'c@example.com', 'Dentist'),
      ]);
    });
  });

  afterAll(async () => {
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('a repeat GET with If-None-Match is a 304 without rendering, and other encodings come from the cache', async () => {
    const first = await get(`/${token}/alice-work.ics`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(first.headers.get('vary')).toBe('Accept-Encoding');
    expect(first.headers.get('cache-control')).toBe('private, max-age=300');
    expect(first.headers.get('last-modified')).not.toBeNull();
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"pub_\w+\.1\.\d+\.0\.\d+"$/);
    expect(uidsOf(await first.text()).sort()).toEqual(['a@example.com', 'shared@example.com']);
    const rendered = renders;

    const again = await get(`/${token}/alice-work.ics`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(await again.text()).toBe('');
    const since = await get(`/${token}/alice-work.ics`, { headers: { 'If-Modified-Since': first.headers.get('last-modified') ?? '' } });
    expect(since.status).toBe(304);

    const br = await get(`/${token}/alice-work.ics`, { headers: { 'Accept-Encoding': 'gzip, br' } });
    expect(br.headers.get('content-encoding')).toBe('br');
    const gzip = await get(`/${token}/alice-work.ics`, { headers: { 'Accept-Encoding': 'gzip, br;q=0' } });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(uidsOf(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gzip.arrayBuffer()))))).toHaveLength(2);
    expect(renders).toBe(rendered);
  });

  test('HEAD returns the headers without a body', async () => {
    const res = await get(`/${token}/alice-home.ics`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^"pub_/);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  test('the combined feed has every source UID once and parses as a valid calendar', async () => {
    const res = await get(`/${token}/all.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')?.split('~')).toHaveLength(2);
    const text = await res.text();
    expect(uidsOf(text).sort()).toEqual(['a@example.com', 'c@example.com', 'shared@example.com']);

    const vcalendar = new ICAL.Component(ICAL.parse(text));
    expect(vcalendar.getFirstPropertyValue('x-wr-calname')).toBe('Alice’s feed');
    expect(vcalendar.getFirstPropertyValue('method')).toBe('PUBLISH');
    expect(vcalendar.getAllSubcomponents('vtimezone').map((tz) => tz.getFirstPropertyValue('tzid'))).toEqual(['Europe/Berlin']);
    expect(text).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n');
    expect(text).toContain('X-PUBLISHED-TTL:PT1H\r\n');
    expect(text).not.toContain('X-WR-TIMEZONE');

    const single = await (await get(`/${token}/alice-home.ics`)).text();
    expect(single).toContain('X-WR-CALNAME:Alice home\r\n');
    expect(single).toContain('COLOR:#336699\r\n');
  });

  test('empty combined feeds in different tenants cache their own names and rename changes the ETag', async () => {
    const otherTenant = `org_${crypto.randomUUID()}` as TenantId;
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: otherTenant, name: 'Other', slug: otherTenant, createdAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: otherTenant, userId, role: 'member', createdAt: now });
    const first = await withTenant(tenantId, (tx) => feeds.createFeed(tx, principal, 'First empty feed'));
    const second = await withTenant(otherTenant, (tx) => feeds.createFeed(tx, { ...principal, tenantId: otherTenant }, 'Second empty feed'));
    const nameOf = (body: string) => new ICAL.Component(ICAL.parse(body)).getFirstPropertyValue('x-wr-calname');
    const firstResponse = await get(`/${first.secrets.ics.token}/all.ics`);
    const secondResponse = await get(`/${second.secrets.ics.token}/all.ics`);
    expect(firstResponse.status).toBe(200); expect(secondResponse.status).toBe(200);
    expect(nameOf(await firstResponse.text())).toBe('First empty feed');
    expect(nameOf(await secondResponse.text())).toBe('Second empty feed');
    expect(secondResponse.headers.get('etag')).not.toBe(firstResponse.headers.get('etag'));
    await withTenant(tenantId, (tx) => feeds.updateFeed(tx, principal, first.feed.id, { name: 'Renamed empty feed' }));
    const renamed = await get(`/${first.secrets.ics.token}/all.ics`, { headers: { 'If-None-Match': firstResponse.headers.get('etag')! } });
    expect(renamed.status).toBe(200);
    expect(renamed.headers.get('etag')).not.toBe(firstResponse.headers.get('etag'));
    expect(nameOf(await renamed.text())).toBe('Renamed empty feed');
  });

  test('tombstone purge never resurrects cached events in feeds or public links', async () => {
    const cal = calendar('big');
    const created = await withTenant(tenantId, async (tx) => {
      const created = await feeds.createFeed(tx, principal, 'Purge regression');
      await feeds.createPublication(tx, principal, created.feed.id, { kind: 'passthrough', sourceCalendarId: cal.id, name: 'Purge' });
      await recordChanges(tx, [event(cal.id, 'deleted@example.com', 'Deleted event'), event(cal.id, 'survivor@example.com', 'Survivor')]);
      return created;
    });
    const published = await api.request(`/api/v1/calendars/${cal.id}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ privacy: 'full' }) });
    expect(published.status).toBe(201);
    const link = CreatedCalendarLink.parse(await published.json());
    const paths = [`/${created.secrets.ics.token}/purge.ics`, `/${created.secrets.ics.token}/all.ics`, `/l/${link.token}.ics`];
    const before = new Map<string, string>();
    for (const path of paths) {
      const response = await get(path); expect(response.status).toBe(200);
      before.set(path, response.headers.get('etag')!);
      expect(uidsOf(await response.text())).toContain('deleted@example.com');
    }
    const { maxSeq: deleted } = await withTenant(tenantId, (tx) => recordChanges(tx, [{ op: 'delete', sourceCalendarId: cal.id, uid: 'deleted@example.com' }]));
    const afterDelete = new Map<string, string>();
    for (const path of paths) {
      const response = await get(path);
      afterDelete.set(path, response.headers.get('etag')!);
      expect(response.headers.get('etag')).not.toBe(before.get(path)!);
      expect(uidsOf(await response.text())).not.toContain('deleted@example.com');
    }
    // Advance the purge cutoff beyond the deletions without writing resource outside changes.ts.
    const cutoff = new Date(Date.now() + 60_000);
    await withControl((tx) => purgeTombstones(tx, cutoff));
    const retained = await withTenant(tenantId, (tx) => changesSince(tx, [cal.id], 0n, 100));
    expect(retained.rows.find((row) => row.uid === 'deleted@example.com')).toMatchObject({ deleted: true, seq: deleted });
    for (const path of paths) {
      const response = await get(path);
      expect(response.headers.get('etag')).toBe(afterDelete.get(path)!);
      expect(response.headers.get('etag')).not.toBe(before.get(path)!);
      expect(uidsOf(await response.text())).not.toContain('deleted@example.com');
    }
    await withTenant(tenantId, (tx) => recordChanges(tx, [event(cal.id, 'newer@example.com', 'Newer')]));
    await withControl((tx) => purgeTombstones(tx, cutoff));
    const purged = await withTenant(tenantId, (tx) => changesSince(tx, [cal.id], 0n, 100));
    expect(purged.rows.some((row) => row.uid === 'deleted@example.com')).toBe(false);
    for (const path of paths) {
      const response = await get(path);
      expect(response.headers.get('etag')).not.toBe(before.get(path)!);
      expect(response.headers.get('etag')).not.toBe(afterDelete.get(path)!);
      expect(uidsOf(await response.text()).sort()).toEqual(['newer@example.com', 'survivor@example.com']);
    }
  });

  test('an unknown token or slug is a 404 with an empty body', async () => {
    for (const path of [`/not-a-token/all.ics`, `/${token}/nope.ics`, `/${token}/alice-work`, `/${token}`]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
  });

  test('rotating the ICS token makes the old URLs 404', async () => {
    const before = token;
    const rotated = await withTenant(tenantId, (tx) => feeds.rotateIcsToken(tx, principal, feedId));
    token = rotated.token;
    expect((await get(`/${before}/all.ics`)).status).toBe(404);
    expect((await get(`/${token}/all.ics`)).status).toBe(200);
  });

  test('the subscribe info carries placeholders, and links expand only for the current token', async () => {
    const info = await api.request(`/api/v1/feeds/${feedId}/subscribe`);
    expect(info.status).toBe(200);
    const body = (await info.json()) as { links: SubscribeLinks };
    expect(body).toMatchObject({
      caldav: { serverUrl: 'http://localhost:4316/dav/', wellKnown: 'http://localhost:4316/.well-known/caldav' },
      ics: { hasToken: true, combinedPath: '/ics/{token}/all.ics', publications: [{ path: '/ics/{token}/alice-work.ics' }, { path: '/ics/{token}/alice-home.ics' }] },
      appleProfileUrl: `/api/v1/feeds/${feedId}/mobileconfig`,
    });
    expect(body.links.google).toBe('https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Flocalhost%3A4316%2Fics%2F{token}%2Fall.ics');
    expect(JSON.stringify(body)).not.toContain(token);

    const expand = (candidate: string) =>
      api.request(`/api/v1/feeds/${feedId}/subscribe/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: candidate }) });
    const expanded = (await (await expand(token)).json()) as SubscribeLinks;
    expect(expanded.google).toBe(body.links.google.replace('{token}', token));
    expect((await expand('wrong')).status).toBe(400);

    const profile = await api.request(`/api/v1/feeds/${feedId}/mobileconfig`);
    expect(profile.headers.get('content-type')).toBe('application/x-apple-aspen-config');
    expect(profile.headers.get('content-disposition')).toBe('attachment; filename="supercal.mobileconfig"');
  });

  test.skipIf(!process.env.BENCH)('benchmark: 5,000 events render cold under 400 ms and serve cached under 20 ms', async () => {
    await withTenant(tenantId, async (tx) => {
      await feeds.createPublication(tx, principal, feedId, { kind: 'passthrough', sourceCalendarId: calendar('big').id, name: 'Big' });
      await recordChanges(
        tx,
        Array.from({ length: 5000 }, (_, i) => event(calendar('big').id, `big-${i}@example.com`, `Event ${i}`, i % 365)),
      );
    });
    const timed = async (headers: Record<string, string>) => {
      const start = performance.now();
      const res = await get(`/${token}/big.ics`, { headers });
      const bytes = (await res.arrayBuffer()).byteLength;
      return { ms: performance.now() - start, bytes, encoding: res.headers.get('content-encoding') ?? 'identity' };
    };
    const cold = await timed({ 'Accept-Encoding': 'br, gzip' });
    // Medians of nine, since each cached response still costs two database transactions.
    const median = async (headers: Record<string, string>) => {
      const runs = [];
      for (let i = 0; i < 9; i++) runs.push(await timed(headers));
      return runs.sort((a, b) => a.ms - b.ms)[4] ?? cold;
    };
    const cached = await median({ 'Accept-Encoding': 'br, gzip' });
    const cachedGzip = await median({ 'Accept-Encoding': 'gzip' });
    console.log(
      `ICS bench (5,000 events): cold ${cold.ms.toFixed(0)} ms (${cold.encoding} ${cold.bytes} B); cached median ${cached.ms.toFixed(1)} ms, gzip ${cachedGzip.ms.toFixed(1)} ms (${cachedGzip.bytes} B)`,
    );
    expect(cold.ms).toBeLessThan(400);
    expect(cached.ms).toBeLessThan(20);
  }, 120_000);
});
