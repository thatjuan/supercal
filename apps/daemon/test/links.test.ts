/** Published-link management, tenant isolation, secret handling and ICS lifecycle over real Postgres. */
import { parseCalendar, summary } from '@supercal/core';
import { auditLog, calendarAccount, calendarLink, closeDb, connectDb, member, migrate, organization, recordChanges, sourceCalendar, user, withControl, withTenant, type SourceCalendar, type TenantId } from '@supercal/db';
import { scratchDatabase, sqlState, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { createApi } from '../src/api/index.ts';
import { CalendarLinkInfo, CreatedCalendarLink } from '../src/api/links.ts';
import { Problem } from '../src/api/kit/problem.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { icsTokenHash } from '../src/feeds/credentials.ts';
import { createFeedService } from '../src/feeds/service.ts';
import { createCalendar, deleteCalendar, restoreCalendar } from '../src/hosted/calendars.ts';
import { writeObject } from '../src/hosted/objects.ts';
import { createIcs } from '../src/ics/index.ts';
import { upsertOf } from '../src/sync/changes.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';
import { eventIcs } from './dav/fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const otherTenant = `org_${crypto.randomUUID()}` as TenantId;
const alice: Principal = { kind: 'user', userId: `alice_${crypto.randomUUID()}`, tenantId, role: 'member', via: 'session', isOperator: false };
let principal = alice;
const inject = createMiddleware<ApiEnv>(async (c, next) => { c.set('principal', principal); await next(); });
const feeds = createFeedService(testSecrets);
const ics = new Hono().route('/ics', createIcs({ secrets: testSecrets, cacheBytes: 1024 * 1024 }));
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let api: ReturnType<typeof createApi>;

const payload = (title = 'Private meeting') => eventIcs('meeting@example.com', [
  'DTSTART:20261110T090000Z', 'DURATION:PT1H', `SUMMARY:${title}`, 'CLASS:PRIVATE',
  'DESCRIPTION:Confidential notes', 'ATTENDEE:mailto:guest@example.com', 'ORGANIZER:mailto:alice@example.com',
]);
const create = (name = 'Published calendar') => withTenant(tenantId, (tx) => createCalendar(tx, feeds, alice.userId, { name }));
const write = (calendar: SourceCalendar, title?: string) => withTenant(tenantId, (tx) => writeObject(tx, calendar, { objectName: 'meeting.ics', payload: payload(title) }));
const call = (id: string, method = 'GET', body?: unknown, linkId?: string) => api.request(`/api/v1/calendars/${id}/links${linkId ? `/${linkId}` : ''}`, {
  method, headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }),
});
async function publish(calendar: SourceCalendar, privacy: 'full' | 'title-only' | 'busy-only' = 'full') {
  const response = await call(calendar.id, 'POST', { privacy, name: 'Client' });
  expect(response.status).toBe(201);
  return CreatedCalendarLink.parse(await response.json());
}
const get = (token: string, headers?: Record<string, string>, method = 'GET') => ics.request(`/ics/l/${token}.ics`, { method, headers });

describe.skipIf(!testDatabaseUrl)('published calendar links', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('links');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    api = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }, inject);
    const now = new Date();
    for (const id of [tenantId, otherTenant]) await unsafeDb().insert(organization).values({ id, name: id, slug: id, createdAt: now });
    await unsafeDb().insert(user).values({ id: alice.userId, name: 'Alice', email: 'alice@example.com', updatedAt: now });
    for (const id of [tenantId, otherTenant]) await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: id, userId: alice.userId, role: 'member', createdAt: now });
  });
  afterAll(async () => { await fixture?.close(); await closeDb(); await scratch?.drop(); });

  test('create, conditional GET, changed object, metadata, calendar delete/restore and immediate revocation', async () => {
    const calendar = await create();
    await write(calendar);
    const link = await publish(calendar);
    expect(link.url).toBe(`http://localhost:4316/ics/l/${link.token}.ics`);
    expect(link.webcalUrl).toBe(`webcal://localhost:4316/ics/l/${link.token}.ics`);
    expect(new URL(link.subscribe.google).searchParams.get('cid')).toBe(link.webcalUrl);
    for (const url of [link.subscribe.outlookPersonal, link.subscribe.outlookWork]) expect(new URL(url).searchParams.get('url')).toBe(link.url);
    const first = await get(link.token);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(new RegExp(`^"lnk\\.${link.id}\\.0\\.\\d+\\.\\d+\\.1"$`));
    const body = await first.text();
    expect(body).toContain('SUMMARY:Busy');
    expect(body).toContain('X-WR-CALNAME:Published calendar');
    expect(body).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(body).not.toContain('ATTENDEE');
    expect(body).not.toContain('Private meeting');
    const conditional = await get(link.token, { 'If-None-Match': etag });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
    expect((await get(link.token, { 'If-Modified-Since': first.headers.get('last-modified') ?? '' })).status).toBe(304);
    const head = await get(link.token, undefined, 'HEAD');
    expect(head.headers.get('etag')).toBe(etag);
    expect(await head.text()).toBe('');
    const compressed = await get(link.token, { 'Accept-Encoding': 'gzip' });
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer())))).toBe(body);

    // A new duration changes even private busy output.
    await withTenant(tenantId, (tx) => writeObject(tx, calendar, { objectName: 'meeting.ics', payload: payload().replace('PT1H', 'PT2H') }));
    const changed = await get(link.token, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    const changedBody = await changed.text();
    expect(changedBody).not.toBe(body);
    expect(changedBody).toContain('DURATION:PT2H');
    await withTenant(tenantId, (tx) => tx.update(sourceCalendar).set({ name: 'Renamed calendar', updatedAt: new Date(Date.now() + 1000) }).where(eq(sourceCalendar.id, calendar.id)));
    const renamed = await get(link.token, { 'If-None-Match': changed.headers.get('etag') ?? '' });
    expect(renamed.status).toBe(200);
    expect(await renamed.text()).toContain('X-WR-CALNAME:Renamed calendar');
    await withTenant(tenantId, (tx) => deleteCalendar(tx, feeds, calendar.id));
    const gone = await get(link.token);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe('');
    await withTenant(tenantId, (tx) => restoreCalendar(tx, calendar.id));
    expect((await get(link.token)).status).toBe(200);
    expect((await call(calendar.id, 'DELETE', undefined, link.id)).status).toBe(204);
    const revoked = await get(link.token, { 'If-None-Match': etag });
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe('');
  });

  test('expired and unknown links are indistinguishable, even for cached conditional requests', async () => {
    const calendar = await create();
    const link = await publish(calendar);
    const first = await get(link.token);
    await unsafeDb().update(calendarLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(calendarLink.id, link.id));
    for (const token of [link.token, 'unknown']) {
      const response = await get(token, { 'If-None-Match': first.headers.get('etag') ?? '' });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    const extensionless = await ics.request('/ics/l/unknown');
    expect(extensionless.status).toBe(404);
    expect(await extensionless.text()).toBe('');
  });

  test('two busy links have unlinkable UIDs and expose no email addresses', async () => {
    const calendar = await create();
    await write(calendar);
    const links = await Promise.all([publish(calendar, 'busy-only'), publish(calendar, 'busy-only')]);
    const bodies = await Promise.all(links.map(async (link) => (await get(link.token)).text()));
    const uids = bodies.map((body) => {
      expect(body).toContain('SUMMARY:Busy');
      expect(body).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      expect(body).not.toContain('mailto:');
      expect(body).not.toContain('Private meeting');
      return parseCalendar(body).resources[0]?.uid;
    });
    expect(uids[0]).toMatch(/^[\w-]{26}@supercal$/);
    expect(uids[1]).not.toBe(uids[0]);
    expect((await get(links[0]!.token)).headers.get('etag')).not.toBe((await get(links[1]!.token)).headers.get('etag'));
  });

  test('links publish imported calendar resources', async () => {
    const [account] = await unsafeDb().insert(calendarAccount).values({ tenantId, ownerUserId: alice.userId, provider: 'ics', displayName: 'Imported' }).returning();
    if (!account) throw new Error('No account');
    const [calendar] = await unsafeDb().insert(sourceCalendar).values({ tenantId, accountId: account.id, providerCalendarId: 'imported', name: 'Imported' }).returning();
    if (!calendar) throw new Error('No calendar');
    const data = parseCalendar(payload('Imported event').replace('CLASS:PRIVATE\r\n', '')).resources[0];
    if (!data) throw new Error('No event');
    await withTenant(tenantId, (tx) => recordChanges(tx, [upsertOf(calendar, data.uid, data, 'complete')]));
    const link = await publish(calendar, 'title-only');
    const response = await get(link.token);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(summary(parseCalendar(body).resources[0]!.master!)).toBe('Imported event');
    expect(body).not.toContain('ATTENDEE');
  });

  test('only create returns secrets, hashes are stored, control access is narrow and audits have no token', async () => {
    const calendar = await create();
    const link = await publish(calendar, 'busy-only');
    const [stored] = await unsafeDb().select().from(calendarLink).where(eq(calendarLink.id, link.id));
    expect(stored?.tokenHash).toBe(icsTokenHash(link.token));
    expect(JSON.stringify(stored)).not.toContain(link.token);
    const listed = await (await call(calendar.id)).json();
    expect(z.object({ items: z.array(CalendarLinkInfo) }).parse(listed).items).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/token|uidSecret|subscribe|webcalUrl/);
    const patched = await call(calendar.id, 'PATCH', { name: 'Website', expiresAt: new Date(Date.now() + 3600000).toISOString() }, link.id);
    expect(patched.status).toBe(200);
    const patch = await patched.json();
    expect(CalendarLinkInfo.parse(patch).name).toBe('Website');
    expect(JSON.stringify(patch)).not.toMatch(/token|uidSecret|subscribe/);
    const cleared = await call(calendar.id, 'PATCH', { expiresAt: null }, link.id);
    expect(CalendarLinkInfo.parse(await cleared.json()).expiresAt).toBeNull();
    // Column privileges enforce privacy immutability and prevent pre-tenant resource/secret reads.
    expect(await sqlState(withTenant(tenantId, (tx) => tx.update(calendarLink).set({ privacy: 'full' }).where(eq(calendarLink.id, link.id))))).toBe('42501');
    expect(await sqlState(withControl((tx) => tx.select({ uidSecret: calendarLink.uidSecret }).from(calendarLink)))).toBe('42501');
    await call(calendar.id, 'DELETE', undefined, link.id);
    const audits = await unsafeDb().select().from(auditLog).where(eq(auditLog.targetId, link.id));
    expect(audits.map((row) => row.action)).toEqual(['link.create', 'link.update', 'link.update', 'link.delete']);
    expect(JSON.stringify(audits)).not.toContain(link.token);
  });

  test('privacy is explicit and immutable, expiry is future-only, quota is serialized and tenant isolation is 404', async () => {
    const calendar = await create();
    expect((await call(calendar.id, 'POST', {})).status).toBe(400);
    expect((await call(calendar.id, 'POST', { privacy: 'full', expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    const link = await publish(calendar);
    expect((await call(calendar.id, 'PATCH', { privacy: 'busy-only' }, link.id)).status).toBe(400);
    expect((await call(calendar.id, 'PATCH', { expiresAt: new Date(Date.now() - 1000).toISOString() }, link.id)).status).toBe(400);
    principal = { ...alice, tenantId: otherTenant };
    try {
      for (const [method, body, id] of [
        ['GET', undefined, undefined], ['POST', { privacy: 'full' }, undefined], ['PATCH', { name: 'No' }, link.id], ['DELETE', undefined, link.id],
      ] as const) expect((await call(calendar.id, method, body, id)).status).toBe(404);
    } finally { principal = alice; }
    // Fill to nineteen, then two concurrent creators compete for the final place.
    for (let i = 1; i < 19; i++) await publish(calendar);
    const last = await Promise.all([call(calendar.id, 'POST', { privacy: 'busy-only' }), call(calendar.id, 'POST', { privacy: 'title-only' })]);
    expect(last.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = last.find((response) => response.status === 409)!;
    expect(Problem.parse(await rejected.json()).type).toBe('https://supercal.dev/problems/link-quota');
    const [total] = await unsafeDb().select({ count: sql<number>`count(*)::int` }).from(calendarLink).where(eq(calendarLink.calendarId, calendar.id));
    expect(total?.count).toBe(20);
  });
});
