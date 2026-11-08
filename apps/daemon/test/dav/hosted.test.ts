import { MAX_OBJECT_BYTES } from '@supercal/core';
import { auditLog, closeDb, connectDb, davLogin, feed, member, migrate, resource, sourceCalendar, sourceObject, user, withControl, withTenant, type SourceCalendar, type TenantId } from '@supercal/db';
import { scratchDatabase, sqlState, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { createApi } from '../../src/api/index.ts';
import { Calendar } from '../../src/api/calendars.ts';
import type { ApiEnv, Principal } from '../../src/auth/principal.ts';
import { idleBus } from '../../src/bus.ts';
import { createIcs } from '../../src/ics/index.ts';
import { createDav } from '../../src/dav/index.ts';
import { createFeedService } from '../../src/feeds/service.ts';
import { createCalendar } from '../../src/hosted/calendars.ts';
import { testAuth, testSecrets } from '../auth-fixture.ts';
import { eventIcs } from './fixture.ts';
import { DEVICE, seedHosted } from './hosted-fixture.ts';

const principal: Principal = { kind: 'user', via: 'session', userId: DEVICE.userId, tenantId: DEVICE.tenantId, role: 'member', isOperator: false };
let caller = principal;
const inject = createMiddleware<ApiEnv>(async (c, next) => { c.set('principal', caller); await next(); });
const basic = (username = DEVICE.username, password = DEVICE.password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const ics = (uid: string, summary = 'Hosted') => eventIcs(uid, ['DTSTART:20261110T090000Z', 'DURATION:PT1H', `SUMMARY:${summary}`]);
const xml = (root: string, body: string) => `<${root} xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">${body}</${root}>`;
const sync = (token = '') => xml('d:sync-collection', `<d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop>`);
const tokenOf = (text: string) => /<d:sync-token>([^<]+)</.exec(text)?.[1] ?? '';
const home = `/dav/${DEVICE.username}/cal/`;
let path: string;
let calendar: SourceCalendar;
let login: Awaited<ReturnType<typeof seedHosted>>['login'];
let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let auth: ReturnType<typeof testAuth>;
let dav: ReturnType<typeof createDav>;
let api: ReturnType<typeof createApi>;

async function request(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
  const res = await dav.request(url, { method, headers: { Authorization: basic(), ...(method === 'PUT' && { 'Content-Type': 'text/calendar' }), ...headers }, ...(body !== undefined && { body }) });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
async function call(url: string, method = 'GET', body?: unknown) {
  return api.request(`/api/v1${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
const logins = z.object({ items: z.array(z.object({ id: z.string(), username: z.string(), name: z.string(), lastUsedAt: z.string().nullable(), createdAt: z.string() }).strict()) });
const createdLogin = z.object({ id: z.string(), name: z.string(), username: z.string(), password: z.string(), serverUrl: z.string(), createdAt: z.string() }).strict();

// Each error-table row below uses the real service and database, including the quota boundary.
describe.skipIf(!testDatabaseUrl)('hosted CalDAV', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('dav_hosted');
    await migrate(scratch.url);
    connectDb(scratch.url);
    ({ login, calendar } = await seedHosted());
    path = `${home}${calendar.providerCalendarId}/`;
    auth = testAuth('invite', scratch.url);
    api = createApi({ auth: auth.auth, secrets: testSecrets, bus: idleBus }, inject);
    dav = createDav({ secrets: testSecrets, bus: idleBus, publicUrl: 'https://calendar.test' });
  });
  afterAll(async () => { await auth?.close(); await closeDb(); await scratch?.drop(); });

  test('DAV credential rows are tenant-isolated and control lookups have column-limited access', async () => {
    const other = await withTenant('org_other_device' as TenantId, (tx) => tx.select().from(davLogin));
    expect(other).toEqual([]);
    const lookup = await withControl((tx) => tx.select({ id: davLogin.id, username: davLogin.username, passwordHash: davLogin.passwordHash }).from(davLogin).where(eq(davLogin.id, login.id)));
    expect(lookup[0]?.id).toBe(login.id);
    expect(await sqlState(withControl((tx) => tx.select({ name: davLogin.name }).from(davLogin)))).toBe('42501');
  });

  test('PUT and GET preserve bytes and share one ETag with REST', async () => {
    const body = ics('bytes').replace('SUMMARY:Hosted', 'SUMMARY:Unusual\r\n folding\r\nX-CUSTOM:untouched');
    const put = await request('PUT', `${path}client%20name.ics`, body);
    expect(put.status).toBe(201);
    const get = await request('GET', `${path}client%20name.ics`);
    expect(get.text).toBe(body);
    expect(get.headers.get('etag')).toBe(put.headers.get('etag'));
    const [row] = await unsafeDb().select({ revision: resource.revision }).from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, 'bytes')));
    expect(put.headers.get('etag')).toBe(`"${row?.revision}"`);
    const rest = await call(`/calendars/${calendar.id}/events/bytes`);
    expect(rest.headers.get('etag')).toBe(put.headers.get('etag'));
    const replaced = await request('PUT', `${path}client%20name.ics`, ics('bytes', 'Updated'), { 'If-Match': put.headers.get('etag') ?? '' });
    expect(replaced.status).toBe(204);
    expect((await request('DELETE', `${path}client%20name.ics`, undefined, { 'If-Match': replaced.headers.get('etag') ?? '' })).status).toBe(204);
    const actions = await unsafeDb().select({ action: auditLog.action, actor: auditLog.actor, targetType: auditLog.targetType, targetId: auditLog.targetId, data: auditLog.data }).from(auditLog).where(eq(auditLog.targetId, calendar.id));
    expect(actions).toEqual(['event.create', 'event.update', 'event.delete'].map((action) => ({ action, actor: { kind: 'user', userId: DEVICE.userId, via: 'davLogin' }, targetType: 'calendar', targetId: calendar.id, data: { uid: 'bytes' } })));
  });

  test('precondition-failed: If-None-Match and stale If-Match return empty 412', async () => {
    const url = `${path}conditional.ics`;
    await request('PUT', url, ics('conditional'));
    for (const headers of [{ 'If-None-Match': '*' }, { 'If-Match': '"stale"' }]) {
      const res = await request('PUT', url, ics('conditional'), headers);
      expect([res.status, res.text]).toEqual([412, '']);
    }
    expect((await request('DELETE', url, undefined, { 'If-Match': '"stale"' })).status).toBe(412);
  });

  for (const [name, body, condition] of [
    ['invalid-calendar-data', 'not a calendar', 'valid-calendar-data'],
    ['unsupported-component', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo\r\nEND:VTODO\r\nEND:VCALENDAR', 'supported-calendar-component'],
    ['invalid-object', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', 'valid-calendar-object-resource'],
    ['too-large', 'x'.repeat(MAX_OBJECT_BYTES + 1), 'max-resource-size'],
  ] as const) test(`${name}: 403 with the CalDAV condition`, async () => {
    const res = await request('PUT', `${path}rejected.ics`, body);
    expect(res.status).toBe(403);
    expect(res.text).toContain(`<cal:${condition}`);
  });

  test('uid-conflict: a second href identifies the original href', async () => {
    await request('PUT', `${path}first%20name.ics`, ics('conflict'));
    const res = await request('PUT', `${path}second.ics`, ics('conflict'));
    expect(res.status).toBe(403);
    expect(res.text).toContain(`<cal:no-uid-conflict><d:href>${path}first%20name.ics</d:href></cal:no-uid-conflict>`);
  });

  test('quota: 507 with DAV quota-not-exceeded', async () => {
    const full = await withTenant(DEVICE.tenantId, (tx) => createCalendar(tx, createFeedService(testSecrets), DEVICE.userId, { name: 'Full' }));
    await unsafeDb().execute(sql`insert into source_object (tenant_id, source_calendar_id, provider_object_id, format, payload, group_uid)
      select ${DEVICE.tenantId}, ${full.id}, 'quota-' || n || '.ics', 'ical', '', 'quota-' || n from generate_series(1, 50000) n`);
    const res = await request('PUT', `${home}${full.id}/overflow.ics`, ics('overflow'));
    expect(res.status).toBe(507);
    expect(res.text).toContain('<d:quota-not-exceeded');
    await unsafeDb().delete(sourceCalendar).where(eq(sourceCalendar.id, full.id));
  });

  test('not-found: deleting an absent object returns empty 404', async () => {
    const res = await request('DELETE', `${path}absent.ics`);
    expect([res.status, res.text]).toEqual([404, '']);
  });

  test('content type and decoded object names are validated', async () => {
    const res = await request('PUT', `${path}wrong.ics`, ics('wrong'), { 'Content-Type': 'application/json' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('<cal:supported-calendar-data');
    for (const name of ['wrong.txt', `${'é'.repeat(126)}.ics`, 'nested%2Fname.ics'])
      expect((await request('PUT', path + name, ics('bad-name'))).status).toBe(403);
    expect((await request('PUT', `${path}${'a'.repeat(251)}.ics`, ics('long-name'))).status).toBe(201);
  });

  test('incremental sync uses stored names and tombstones; changing a recreated UID name expires the token', async () => {
    const before = tokenOf((await request('REPORT', path, sync())).text);
    await request('PUT', `${path}changed%20name.ics`, ics('sync-changed'));
    await request('PUT', `${path}changed%20name.ics`, ics('sync-changed', 'Edited'));
    await request('PUT', `${path}deleted.ics`, ics('sync-deleted'));
    await request('DELETE', `${path}deleted.ics`);
    const next = await request('REPORT', path, sync(before));
    expect(next.status).toBe(207);
    expect(next.text).toContain(`<d:href>${path}changed%20name.ics</d:href>`);
    expect(next.text).toContain(`<d:href>${path}deleted.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status>`);
    await request('PUT', `${path}new-name.ics`, ics('sync-deleted'));
    const expired = await request('REPORT', path, sync(tokenOf(next.text)));
    expect(expired.status).toBe(403);
    expect(expired.text).toContain('<d:valid-sync-token');
  });

  test('Depth 1 over 5,000 objects takes under 150 ms and selects no payload or resource data', async () => {
    const bulk = await withTenant(DEVICE.tenantId, (tx) => createCalendar(tx, createFeedService(testSecrets), DEVICE.userId, { name: 'Bulk' }));
    await unsafeDb().execute(sql`insert into source_object (tenant_id, source_calendar_id, provider_object_id, format, payload, group_uid, etag)
      select ${DEVICE.tenantId}, ${bulk.id}, 'bulk-' || n || '.ics', 'ical', 'PAYLOAD_MUST_NOT_BE_READ', 'bulk-' || n, 'revision-' || n from generate_series(1, 5000) n`);
    await request('PROPFIND', path); // warm auth and timezone generation outside the measurement
    const client = unsafeDb().$client;
    const oldDebug = client.options.debug;
    const queries: string[] = [];
    client.options.debug = (_connection, query) => { queries.push(query); };
    let elapsed: number;
    let result: Awaited<ReturnType<typeof request>>;
    try {
      const started = performance.now();
      result = await request('PROPFIND', `${home}${bulk.id}/`, xml('d:propfind', '<d:prop><d:getetag/></d:prop>'), { Depth: '1' });
      elapsed = performance.now() - started;
    } finally { client.options.debug = oldDebug; }
    expect(result.status).toBe(207);
    expect([...result.text.matchAll(/<d:response>/g)]).toHaveLength(5001);
    expect(result.text).not.toContain('PAYLOAD_MUST_NOT_BE_READ');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter((q) => /select/i.test(q)).some((q) => /"payload"|"data"/.test(q))).toBe(false);
    expect(elapsed).toBeLessThan(150);
  });

  test('MKCALENDAR honors the segment; PROPPATCH metadata appears in REST and unknown properties fail atomically', async () => {
    const url = `${home}client-choice/`;
    expect((await request('MKCALENDAR', url, xml('cal:mkcalendar', '<d:set><d:prop><d:displayname>Initial</d:displayname></d:prop></d:set>'))).status).toBe(201);
    const exists = await request('MKCALENDAR', url);
    expect(exists.status).toBe(403);
    expect(exists.text).toContain('<d:resource-must-be-null');
    expect((await request('MKCALENDAR', `${home}cal_reserved/`)).status).toBe(403);
    const patch = await request('PROPPATCH', url, xml('d:propertyupdate', '<d:set><d:prop><d:displayname>Renamed</d:displayname><a:calendar-color>#AABBCC77</a:calendar-color><a:calendar-order>9</a:calendar-order><cal:calendar-description>Device calendar</cal:calendar-description></d:prop></d:set>'));
    expect(patch.status).toBe(207);
    expect(patch.text).not.toContain('403');
    const listed = z.object({ items: z.array(Calendar) }).parse(await (await call('/calendars')).json());
    const item = listed.items.find((c) => c.name === 'Renamed');
    expect(item).toMatchObject({ name: 'Renamed', color: '#aabbcc', sortOrder: 9, description: 'Device calendar' });
    const fail = await request('PROPPATCH', url, xml('d:propertyupdate', '<d:set><d:prop><d:displayname>Must not change</d:displayname><d:unknown/></d:prop></d:set>'));
    expect(fail.status).toBe(207);
    expect(fail.text).toContain('403 Forbidden');
    expect(fail.text).toContain('424 Failed Dependency');
    const unchanged = z.object({ items: z.array(Calendar) }).parse(await (await call('/calendars')).json());
    expect(unchanged.items.find((c) => c.id === item?.id)?.name).toBe('Renamed');
    const timezone = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:America/Vancouver\r\nBEGIN:STANDARD\r\nDTSTART:20261101T020000\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR';
    const zonePatch = await request('PROPPATCH', url, xml('d:propertyupdate', `<d:set><d:prop><cal:calendar-timezone>${timezone}</cal:calendar-timezone></d:prop></d:set>`));
    expect(zonePatch.text).toContain('200 OK');
    const withZone = z.object({ items: z.array(Calendar) }).parse(await (await call('/calendars')).json());
    expect(withZone.items.find((c) => c.id === item?.id)?.timezone).toBe('America/Vancouver');
    const props = await request('PROPFIND', url);
    expect(props.text).toContain('<cal:max-resource-size>1048576</cal:max-resource-size>');
    expect(props.text).toContain('BEGIN:VTIMEZONE');
    expect(props.text).not.toContain('schedule-inbox');
    expect((await request('DELETE', url)).status).toBe(204);
    expect((await request('GET', url)).status).toBe(404);
  });

  test('OPTIONS privileges, login isolation, and feed logins remain read-only', async () => {
    const options = await request('OPTIONS', path);
    expect(options.headers.get('allow')).toContain('PUT');
    const homeProps = await request('PROPFIND', home);
    expect(homeProps.text).toContain('<d:bind/>');
    const collectionProps = await request('PROPFIND', path);
    for (const p of ['write-content', 'write-properties', 'write', 'bind', 'unbind']) expect(collectionProps.text).toContain(`<d:${p}/>`);
    const other = await request('PROPFIND', '/dav/another-login/cal/');
    expect(other.status).toBe(403);
    const [f] = await unsafeDb().select().from(feed).where(eq(feed.ownerUserId, DEVICE.userId));
    if (!f) throw new Error('No feed');
    await unsafeDb().update(feed).set({ caldavPasswordHash: await Bun.password.hash('feed-password', { algorithm: 'argon2id' }) }).where(eq(feed.id, f.id));
    const res = await request('PUT', `/dav/${f.caldavUsername}/cal/missing/event.ics`, ics('feed'), { Authorization: basic(f.caldavUsername, 'feed-password') });
    expect(res.status).toBe(403);
    expect(res.text).toContain('<d:need-privileges');
    for (const method of ['MOVE', 'COPY', 'LOCK', 'UNLOCK', 'MKCOL', 'POST']) {
      const unsupported = await request(method, path);
      expect(unsupported.status).toBe(403);
      expect(unsupported.text).toContain('<d:need-privileges');
    }
  });

  test('device credentials cannot open the API or feeds; bearer API credentials cannot open DAV', async () => {
    const realApi = createApi({ auth: auth.auth, secrets: testSecrets, bus: idleBus });
    expect((await realApi.request('/api/v1/me', { headers: { Authorization: basic() } })).status).toBe(401);
    const issued = await call('/api-keys', 'POST', { name: 'DAV isolation test' });
    expect(issued.status).toBe(201);
    const key = z.object({ key: z.string() }).parse(await issued.json()).key;
    expect((await realApi.request('/api/v1/me', { headers: { Authorization: `Bearer ${key}` } })).status).toBe(200);
    expect((await request('PROPFIND', path, undefined, { Authorization: `Bearer ${key}` })).status).toBe(401);
    const icsApp = createIcs({ secrets: testSecrets, cacheBytes: 1024 });
    expect((await icsApp.request(`/${DEVICE.password}/all.ics`, { headers: { Authorization: basic() } })).status).toBe(404);
  });

  test('DAV login API returns secrets once, enforces owner and admin revocation, and audits', async () => {
    const res = await call('/dav-logins', 'POST', { name: 'Work iPhone' });
    expect(res.status).toBe(201);
    const created = createdLogin.parse(await res.json());
    expect(created.username).toMatch(/^writer-dav-[a-z0-9]{8}$/);
    const list = logins.parse(await (await call('/dav-logins')).json());
    expect(list.items.map((r) => r.id)).toContain(created.id);
    expect(JSON.stringify(list)).not.toContain(created.password);
    const stored = await unsafeDb().select().from(davLogin).where(eq(davLogin.username, created.username));
    expect(stored[0]?.passwordHash).toStartWith('$argon2id$');
    expect(await Bun.password.verify(created.password, stored[0]!.passwordHash)).toBe(true);
    const credential = { Authorization: basic(created.username, created.password) };
    expect((await request('PROPFIND', '/dav/', undefined, credential)).status).toBe(207);
    caller = { ...principal, userId: 'other-user' };
    expect(logins.parse(await (await call('/dav-logins')).json()).items).toHaveLength(0);
    expect((await call(`/dav-logins/${created.id}`, 'DELETE')).status).toBe(403);
    caller = { ...caller, role: 'admin' };
    expect((await call(`/dav-logins/${created.id}`, 'DELETE')).status).toBe(204);
    caller = principal;
    expect((await request('PROPFIND', '/dav/', undefined, credential)).status).toBe(401);
    const actions = await unsafeDb().select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.targetId, created.id));
    expect(actions.map((a) => a.action)).toEqual(['dav-login.create', 'dav-login.delete']);
  });

  test('last_used_at changes at most once per hour and removal or banning revokes cached logins immediately', async () => {
    await request('PROPFIND', '/dav/');
    const read = async () => (await unsafeDb().select().from(davLogin).where(eq(davLogin.id, login.id)))[0]!;
    const before = (await read()).lastUsedAt;
    await request('PROPFIND', '/dav/');
    expect((await read()).lastUsedAt).toEqual(before);
    await unsafeDb().update(davLogin).set({ lastUsedAt: sql`now() - interval '2 hours'` }).where(eq(davLogin.id, login.id));
    await request('PROPFIND', '/dav/');
    expect((await read()).lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    await unsafeDb().update(user).set({ banned: true }).where(eq(user.id, DEVICE.userId));
    expect((await request('PROPFIND', '/dav/')).status).toBe(401);
    await unsafeDb().update(user).set({ banned: false }).where(eq(user.id, DEVICE.userId));
    expect((await request('PROPFIND', '/dav/')).status).toBe(207);
    await unsafeDb().delete(member).where(eq(member.id, 'member_hosted_dav'));
    expect((await request('PROPFIND', '/dav/')).status).toBe(401);
    await unsafeDb().insert(member).values({ id: 'member_hosted_dav', userId: DEVICE.userId, organizationId: DEVICE.tenantId, role: 'member', createdAt: new Date() });
    expect((await request('PROPFIND', '/dav/')).status).toBe(207);
    expect((await call(`/dav-logins/${login.id}`, 'DELETE')).status).toBe(204);
    expect((await request('PROPFIND', '/dav/')).status).toBe(401);
  });

  test('device quota is 20 per user and returns dav-login-quota', async () => {
    await unsafeDb().insert(davLogin).values(Array.from({ length: 20 }, (_, n) => ({ tenantId: DEVICE.tenantId, userId: DEVICE.userId, name: `Device ${n}`, username: `quota-dav-device${n}`, passwordHash: 'unused' })));
    const res = await call('/dav-logins', 'POST', { name: 'Too many' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ type: 'https://supercal.dev/problems/dav-login-quota' });
  });
});
