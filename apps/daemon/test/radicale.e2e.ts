/**
 * Live end to end against a real Radicale (`bun run test:radicale`; skipped without `RADICALE_URL`
 * and `TEST_DATABASE_URL`). `RADICALE_URL` carries the login, e.g. `http://user:pass@host:5232/`,
 * and `SUPERCAL_EGRESS_ALLOW` must admit its address. It proves tsdav over the guarded transport
 * and the whole path: `POST /api/v1/accounts` → sync engine → the user's CalDAV feed.
 *
 * Seeds a recurring event with an override and an all-day event in a fresh collection, then checks
 * an incremental change (modify + delete), the forced etag mode, and deletes the collection.
 */
import { componentsOf, summary } from '@supercal/core';
import { closeDb, connectDb, member, migrate, organization, resource, sourceCalendar, syncTarget, user, withControl, type SourceCalendarId, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { createGuardedFetch } from '@supercal/providers';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { parseConfig } from '../src/config.ts';
import { createDav } from '../src/dav/index.ts';
import { createLogger } from '../src/log.ts';
import { createSyncDeps, syncHandlers } from '../src/sync/index.ts';
import { startScheduler, wakeTargets } from '../src/sync/scheduler.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const radicale = process.env.RADICALE_URL ? new URL(process.env.RADICALE_URL) : null;
const login = radicale ? { username: decodeURIComponent(radicale.username), password: decodeURIComponent(radicale.password) } : null;
const serverUrl = radicale ? `${radicale.protocol}//${radicale.host}/` : '';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const principal: Principal = { kind: 'user', userId: `user_e2e_${crypto.randomUUID().slice(0, 8)}`, tenantId, role: 'owner', via: 'session', isOperator: false };
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const SERIES = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//supercal e2e//EN',
  'BEGIN:VEVENT', 'UID:e2e-series', 'DTSTAMP:20261107T000000Z', 'DTSTART:20261109T170000Z', 'DTEND:20261109T180000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Standup', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e2e-series', 'DTSTAMP:20261107T000000Z', 'RECURRENCE-ID:20261116T170000Z', 'DTSTART:20261116T190000Z', 'DTEND:20261116T200000Z', 'SUMMARY:Moved standup', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');
const DAY = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//supercal e2e//EN', 'BEGIN:VEVENT', 'UID:e2e-day', 'DTSTAMP:20261107T000000Z', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'SUMMARY:Day off', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

/** Writes to Radicale directly (test setup, not the adapter's path). */
async function radicaleRequest(path: string, method: string, body?: string, contentType = 'text/calendar') {
  const headers = { authorization: `Basic ${btoa(`${login?.username}:${login?.password}`)}`, 'content-type': contentType };
  const res = await fetch(new URL(path, serverUrl), { method, headers, ...(body !== undefined && { body }) });
  await res.body?.cancel();
  return res.status;
}

/** The calendar's live resources as uid → summaries of master and overrides. */
async function resources(calendarId: SourceCalendarId) {
  const rows = await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, calendarId), eq(resource.deleted, false))).orderBy(resource.uid);
  return Object.fromEntries(rows.map((r) => [r.uid, r.data ? componentsOf(r.data).map(summary) : []]));
}

async function eventually<T>(check: () => Promise<T>, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; await Bun.sleep(100)) {
    const value = await check();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
  }
}

describe.skipIf(!radicale || !testDatabaseUrl)('Radicale end to end', () => {
  const collection = `/${login?.username}/supercal-e2e-${Date.now()}/`;
  let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
  let fixture: ReturnType<typeof testAuth> | undefined;
  const stop = new AbortController();
  let scheduler: Promise<void> | undefined;

  beforeAll(async () => {
    scratch = await scratchDatabase('radicale');
    await migrate(scratch.url);
    connectDb(scratch.url);
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'E2E', slug: tenantId, createdAt: now });
    await unsafeDb().insert(user).values({ id: principal.userId, name: 'e2e', email: 'e2e@example.com', updatedAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: principal.userId, role: 'owner', createdAt: now });

    const mkcalendar = `<c:mkcalendar xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>Supercal E2E</d:displayname><a:calendar-color>#48aaffff</a:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
    expect(await radicaleRequest(collection, 'MKCALENDAR', mkcalendar, 'application/xml')).toBe(201);
    expect([201, 204]).toContain(await radicaleRequest(`${collection}series.ics`, 'PUT', SERIES));
    expect([201, 204]).toContain(await radicaleRequest(`${collection}day.ics`, 'PUT', DAY));
  });

  afterAll(async () => {
    stop.abort();
    await scheduler;
    if (radicale) console.log('cleanup collection', await radicaleRequest(collection, 'DELETE'));
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('an account added through the API syncs into the feed, incrementally and in forced etag mode', async () => {
    const config = parseConfig({ ...process.env, DATABASE_URL: scratch?.url, SUPERCAL_INSECURE_DEV: '1' });
    if (!config.ok) throw new Error(config.problems.join('; '));
    const egress = createGuardedFetch({ allow: config.config.SUPERCAL_EGRESS_ALLOW });
    fixture = testAuth('invite', scratch?.url ?? '');
    const api = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus, fetch: egress }, injectPrincipal);
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const res = await api.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const created = await call('/api/v1/accounts', 'POST', { provider: 'caldav', serverUrl, ...login });
    expect(created.status).toBe(201);
    const calendar = (created.body.calendars as { id: SourceCalendarId; name: string; color: string | null }[]).find((c) => c.name === 'Supercal E2E');
    if (!calendar) throw new Error(`calendar not listed: ${JSON.stringify(created.body.calendars)}`);
    expect(calendar.color?.toUpperCase()).toBe('#48AAFF');
    const [stored] = await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.id, calendar.id));
    expect(stored?.capabilities).toEqual({ incremental: 'sync-collection', push: false });

    const log = createLogger({}, () => {});
    scheduler = startScheduler({ handlers: syncHandlers(createSyncDeps({ secrets: testSecrets, fetch: egress, log })), log, signal: stop.signal, pollMs: 200, leaseMs: 30_000 });
    const [target] = await unsafeDb().select().from(syncTarget).where(and(eq(syncTarget.kind, 'events'), eq(syncTarget.targetId, calendar.id)));
    if (!target) throw new Error('no events target');
    const wake = () => withControl((tx) => wakeTargets(tx, [target.id]));
    const cursor = async () => (await unsafeDb().select({ cursor: syncTarget.cursor }).from(syncTarget).where(eq(syncTarget.id, target.id)))[0]?.cursor as { mode?: string; token?: string; etags?: object } | null;

    // Initial snapshot: the series with its override, and the all-day event.
    expect(await eventually(() => resources(calendar.id), (r) => Object.keys(r).length === 2)).toEqual({ 'e2e-day': ['Day off'], 'e2e-series': ['Standup', 'Moved standup'] });
    const first = await cursor();
    expect(first?.mode).toBe('sync');

    // The events are in the user's CalDAV feed.
    const [feedRow] = (await call('/api/v1/feeds')).body.items as { id: string }[];
    const credentials = (await call(`/api/v1/feeds/${feedRow?.id}/credentials/caldav/rotate`, 'POST')).body as { username: string; password: string };
    const dav = createDav({ secrets: testSecrets, bus: idleBus });
    const feedAuth = `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
    const home = await dav.request(`/dav/${credentials.username}/cal/`, { method: 'PROPFIND', headers: { authorization: feedAuth, depth: '1' } });
    const collections = [...(await home.text()).matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1] ?? '').filter((h) => h !== `/dav/${credentials.username}/cal/`);
    const report = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"/></c:filter></c:calendar-query>';
    const feedText = (await Promise.all(collections.map(async (href) => (await dav.request(href, { method: 'REPORT', headers: { authorization: feedAuth, depth: '1' }, body: report })).text()))).join('');
    for (const text of ['SUMMARY:Standup', 'SUMMARY:Moved standup', 'SUMMARY:Day off']) expect(feedText).toContain(text);

    // Incremental: modify the series, delete the all-day event.
    await radicaleRequest(`${collection}series.ics`, 'PUT', SERIES.replace('SUMMARY:Standup', 'SUMMARY:Changed standup'));
    expect(await radicaleRequest(`${collection}day.ics`, 'DELETE')).toBe(200);
    await wake();
    expect(await eventually(() => resources(calendar.id), (r) => !('e2e-day' in r))).toEqual({ 'e2e-series': ['Changed standup', 'Moved standup'] });
    const second = await cursor();
    expect(second?.mode).toBe('sync');
    expect(second?.token).not.toBe(first?.token);

    // Forced etag mode: the calendar is downgraded and its cursor dropped.
    await unsafeDb().update(sourceCalendar).set({ capabilities: { incremental: 'etag', push: false } }).where(eq(sourceCalendar.id, calendar.id));
    await unsafeDb().update(syncTarget).set({ cursor: null }).where(eq(syncTarget.id, target.id));
    await wake();
    await eventually(cursor, (c) => c?.mode === 'etag');
    await radicaleRequest(`${collection}series.ics`, 'PUT', SERIES.replace('SUMMARY:Standup', 'SUMMARY:Etag standup'));
    await radicaleRequest(`${collection}day.ics`, 'PUT', DAY);
    await wake();
    expect(await eventually(() => resources(calendar.id), (r) => Object.keys(r).length === 2 && r['e2e-series']?.[0] === 'Etag standup')).toEqual({
      'e2e-day': ['Day off'],
      'e2e-series': ['Etag standup', 'Moved standup'],
    });
    expect(Object.keys((await cursor())?.etags ?? {})).toHaveLength(2);
    await radicaleRequest(`${collection}day.ics`, 'DELETE');
    await wake();
    expect(await eventually(() => resources(calendar.id), (r) => !('e2e-day' in r))).toEqual({ 'e2e-series': ['Etag standup', 'Moved standup'] });
  });
});
