import { parseCalendar } from '@supercal/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { auditLog, calendarAccount, calendarShare, closeDb, connectDb, davLogin, member, migrate, newId, recordChanges, sourceCalendar, user, withTenant, type SourceCalendar, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { Principal, ApiEnv } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { createDav } from '../src/dav/index.ts';
import { createFeedService } from '../src/feeds/service.ts';
import { createCalendar } from '../src/hosted/calendars.ts';
import { accessibleCalendars, effectiveAccess } from '../src/hosted/access.ts';
import { writeObject } from '../src/hosted/objects.ts';
import { upsertOf } from '../src/sync/changes.ts';
import { testAuth, testSecrets, TEST_ORIGIN } from './auth-fixture.ts';
import { eventIcs } from './dav/fixture.ts';

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let fixture: ReturnType<typeof testAuth>;
let app: ReturnType<typeof createApi>, dav: ReturnType<typeof createDav>;
let owner: Principal, colleague: Principal, outsider: Principal, actor: Principal;
let ownerCookie: string, colleagueCookie: string, peerId: string;
const credentials = { username: 'shared-device-abcdefgh', password: 'shared-device-password' };
const home = `/dav/${credentials.username}/cal/`;
const feeds = createFeedService(testSecrets);
const inject = createMiddleware<ApiEnv>(async (c, next) => { c.set('principal', actor); await next(); });
const json = (response: Response) => response.json() as Promise<unknown>;
const Share = z.object({ id: z.string(), etag: z.string() });
const jsEvent = { '@type': 'Event', version: '2.0', title: 'New', start: '2026-11-09T11:00:00', timeZone: 'Etc/UTC', duration: 'PT1H' };
const payload = (uid = 'private') => eventIcs(uid, ['DTSTART:20261109T090000Z', 'DURATION:PT1H', 'CLASS:PRIVATE', 'SUMMARY:Secret', 'DESCRIPTION:Secret details']);
const xml = (root: string, body = '') => `<${root} xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</${root}>`;
const sync = (token = '') => xml('d:sync-collection', `<d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop>`);
const tokenOf = (text: string) => /<d:sync-token>([^<]+)</.exec(text)?.[1] ?? '';
const call = (who: Principal, path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
  actor = who;
  return app.request(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(data !== undefined && { body: typeof data === 'string' ? data : JSON.stringify(data) }) });
};
async function davCall(path: string, method = 'PROPFIND', body?: string, headers: Record<string, string> = {}) {
  const response = await dav.request(path, { method, headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`, ...(method === 'PUT' && { 'Content-Type': 'text/calendar' }), ...headers }, ...(body !== undefined && { body }) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}
async function calendar() {
  const calendar = await withTenant(owner.tenantId, (tx) => createCalendar(tx, feeds, owner.userId, { name: 'Personal' }));
  await withTenant(owner.tenantId, (tx) => writeObject(tx, calendar, { objectName: 'private.ics', payload: payload() }));
  return calendar;
}
async function share(calendar: SourceCalendar, access: 'free-busy' | 'read' | 'write' | 'manage', tenant = false) {
  const response = await call(owner, `/calendars/${calendar.id}/shares`, 'POST', { grantee: tenant ? { type: 'tenant' } : { type: 'user', userId: colleague.userId }, access });
  expect(response.status).toBe(201);
  return Share.parse(await json(response));
}
async function authCall(path: string, cookie: string, body: unknown) {
  return fixture.auth.handler(new Request(`${TEST_ORIGIN}/api/auth${path}`, { method: 'POST', headers: { origin: TEST_ORIGIN, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
async function signup(name: string) {
  const response = await authCall('/sign-up/email', '', { name, email: `${name}@sharing.test`, password: 'correct-horse-battery' });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((s) => s.split(';')[0]).join('; ');
  const data = z.object({ user: z.object({ id: z.string() }) }).parse(await json(response));
  const [membership] = await unsafeDb().select().from(member).where(eq(member.userId, data.user.id));
  if (!membership) throw new Error('No personal tenant');
  return { principal: { kind: 'user', userId: data.user.id, tenantId: membership.organizationId as TenantId, role: 'member', via: 'session', isOperator: false } satisfies Principal, cookie };
}

describe.skipIf(!testDatabaseUrl)('calendar sharing and free-busy', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('sharing'); await migrate(scratch.url); connectDb(scratch.url);
    fixture = testAuth('open', scratch.url);
    const a = await signup('Owner'), b = await signup('Colleague'), c = await signup('Outsider');
    owner = a.principal; colleague = { ...b.principal, tenantId: owner.tenantId }; outsider = c.principal;
    ownerCookie = a.cookie; colleagueCookie = b.cookie;
    const peer = await signup('Peer'); peerId = peer.principal.userId;
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: owner.tenantId, userId: peerId, role: 'member', createdAt: new Date() });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: owner.tenantId, userId: colleague.userId, role: 'member', createdAt: new Date() });
    await unsafeDb().insert(davLogin).values({ tenantId: owner.tenantId, userId: colleague.userId, name: 'Sharing device', username: credentials.username, passwordHash: await Bun.password.hash(credentials.password, { algorithm: 'argon2id' }) });
    app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }, inject);
    dav = createDav({ secrets: testSecrets, bus: idleBus, publicUrl: 'https://calendar.test' });
  });
  afterAll(async () => { await fixture?.close(); await closeDb(); await scratch?.drop(); });

  test('capability matrix for direct and tenant grants, ownership and tenant administration', async () => {
    // free-busy, read, full private details, event writes, metadata, shares/links, delete/restore
    const expected = [
      ['free-busy', 200, 403, false, 403, 403, 403, 403],
      ['read', 200, 200, false, 403, 403, 403, 403],
      ['write', 200, 200, true, 201, 403, 403, 403],
      ['manage', 200, 200, true, 201, 200, 200, 403],
      ['owner', 200, 200, true, 201, 200, 200, 204],
      ['admin', 200, 200, true, 201, 200, 200, 204],
    ] as const;
    for (const tenant of [false, true]) for (const [level, busyStatus, readStatus, full, writeStatus, metadataStatus, shareStatus, deleteStatus] of expected) {
      const cal = await calendar(), path = `/calendars/${cal.id}`;
      if (level !== 'owner' && level !== 'admin') await share(cal, level, tenant);
      const who = level === 'owner' ? owner : level === 'admin' ? { ...colleague, role: 'admin' as const } : colleague;
      const statuses: number[] = [];
      statuses.push((await call(who, '/free-busy', 'POST', { from: '2026-11-09T00:00:00Z', to: '2026-11-10T00:00:00Z', calendarIds: [cal.id] })).status);
      const listing = z.object({ items: z.array(z.object({ id: z.string(), access: z.string() })) }).parse(await json(await call(who, '/calendars')));
      expect(listing.items.find((item) => item.id === cal.id)?.access).toBe(level === 'admin' ? 'owner' : level);
      const read = await call(who, `${path}/events/private`); statuses.push(read.status);
      if (read.ok) expect(await read.text()).toContain(full ? 'Secret' : 'Busy');
      const written = await call(who, `${path}/events`, 'POST', { ...jsEvent, uid: 'write' }); statuses.push(written.status);
      expect((await call(who, `${path}/events/write`, 'PATCH', { title: 'Changed' })).status).toBe(writeStatus === 201 ? 200 : 403);
      expect((await call(who, `${path}/events/write`, 'DELETE')).status).toBe(writeStatus === 201 ? 204 : 403);
      statuses.push((await call(who, path, 'PATCH', { name: 'Renamed', color: '#112233' })).status);
      statuses.push((await call(who, `${path}/shares`)).status);
      expect((await call(who, `${path}/links`)).status).toBe(shareStatus);
      const delegated = await call(who, `${path}/shares`, 'POST', { grantee: { type: 'user', userId: peerId }, access: 'read' });
      expect(delegated.status).toBe(shareStatus === 200 ? 201 : 403);
      if (delegated.ok) {
        const grant = Share.parse(await json(delegated));
        expect((await call(who, `${path}/shares/${grant.id}`, 'PATCH', { access: 'free-busy' })).status).toBe(200);
        expect((await call(who, `${path}/shares/${grant.id}`, 'DELETE')).status).toBe(204);
      }
      const link = await call(who, `${path}/links`, 'POST', { privacy: 'full' });
      expect(link.status).toBe(shareStatus === 200 ? 201 : 403);
      if (link.ok) {
        const created = z.object({ id: z.string() }).parse(await json(link));
        expect((await call(who, `${path}/links/${created.id}`, 'PATCH', { name: 'Managed' })).status).toBe(200);
        expect((await call(who, `${path}/links/${created.id}`, 'DELETE')).status).toBe(204);
      }
      expect((await call(who, `${path}/export.ics`)).status).toBe(readStatus);
      expect((await call(who, `${path}/import`, 'POST', payload('imported-matrix'), { 'content-type': 'text/calendar' })).status).toBe(writeStatus === 201 ? 200 : 403);

      statuses.push((await call(who, path, 'DELETE')).status);
      expect((await call(who, `${path}/restore`, 'POST')).status).toBe(deleteStatus === 204 ? 200 : 403);
      expect({ tenant, level, statuses }).toEqual({ tenant, level, statuses: [busyStatus, readStatus, writeStatus, metadataStatus, shareStatus, deleteStatus] });
      if (tenant) await withTenant(owner.tenantId, (tx) => tx.delete(calendarShare).where(eq(calendarShare.calendarId, cal.id)));
    }
  }, 20_000);

  test('deleted calendars hide every event read from grantees while owners and tenant admins can read', async () => {
    const cal = await calendar(); await share(cal, 'read');
    expect((await call(owner, `/calendars/${cal.id}`, 'DELETE')).status).toBe(204);
    const admin: Principal = { ...colleague, role: 'admin' };
    for (const suffix of ['/events', '/events/private', '/occurrences?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z', '/changes', '/export.ics']) {
      expect((await call(colleague, `/calendars/${cal.id}${suffix}`)).status).toBe(404);
      for (const who of [owner, admin]) {
        const response = await call(who, `/calendars/${cal.id}${suffix}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('Secret');
      }
    }
  });

  test('highest grant wins; free-busy listing omits metadata and owner publication ids', async () => {
    const cal = await calendar(); await share(cal, 'read', true); await share(cal, 'write');
    expect(await withTenant(owner.tenantId, (tx) => effectiveAccess(tx, colleague, cal.id))).toBe('write');
    const visible = await withTenant(owner.tenantId, (tx) => accessibleCalendars(tx, colleague, 'write'));
    expect(visible.find(({ calendar }) => calendar.id === cal.id)?.access).toBe('write');
    expect(await json(await call(colleague, `/calendars/${cal.id}`))).toMatchObject({ publicationIds: [] });
    const owned = z.object({ publicationIds: z.array(z.string()) }).parse(await json(await call(owner, `/calendars/${cal.id}`))); expect(owned.publicationIds.length).toBeGreaterThan(0);
    const fb = await calendar(); await share(fb, 'free-busy');
    const data = await json(await call(colleague, `/calendars/${fb.id}`));
    expect(data).toEqual({ id: fb.id, name: 'Personal', color: null, kind: 'hosted', writable: true, timezone: 'UTC', state: 'active', access: 'free-busy', owner: { id: owner.userId, name: 'Owner' }, publicationIds: [], freshness: { lastSuccessAt: null, pushActive: false, expectedLatency: 0, stale: false } });
    await withTenant(owner.tenantId, (tx) => tx.delete(calendarShare).where(eq(calendarShare.calendarId, cal.id)));
  });

  test('private event read projection covers list, get, occurrences, changes, export and CalDAV', async () => {
    for (const level of ['read', 'write'] as const) {
      const cal = await calendar(); await share(cal, level);
      for (const suffix of ['/events', '/events/private', '/occurrences?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z', '/changes', '/export.ics']) {
        const response = await call(colleague, `/calendars/${cal.id}${suffix}`);
        expect(response.status).toBe(200);
        const text = await response.text(); expect(text).toContain(level === 'read' ? 'Busy' : 'Secret');
        if (level === 'read') expect(text).not.toContain('Secret');
      }
      const response = await davCall(`${home}${cal.id}/`, 'REPORT', xml('c:calendar-query', '<d:prop><c:calendar-data/></d:prop>'));
      expect(response.status).toBe(207); expect(response.text).toContain(level === 'read' ? 'Busy' : 'Secret');
      if (level === 'read') expect(response.text).not.toContain('Secret');
      expect((await davCall(home, 'PROPFIND', undefined, { Depth: '1' })).text).toContain('Personal (Owner)');
    }
  });

  test('read changes report newly hidden events as deleted only during incremental sync', async () => {
    const cal = await calendar(); await share(cal, 'read');
    const path = `/calendars/${cal.id}/changes`;
    const write = (flags: string[]) => withTenant(owner.tenantId, (tx) => writeObject(tx, cal, {
      objectName: 'visible.ics', payload: eventIcs('visible', ['DTSTART:20261109T110000Z', 'DURATION:PT1H', 'SUMMARY:Full details', ...flags]),
    }));
    await write([]);
    const Changes = z.object({ changes: z.array(z.object({ uid: z.string(), deleted: z.boolean(), event: z.object({ title: z.string() }).optional() })), next: z.string() });
    const initial = Changes.parse(await json(await call(colleague, path)));
    expect(initial.changes.find((row) => row.uid === 'visible')).toMatchObject({ deleted: false, event: { title: 'Full details' } });
    await write(['CLASS:PRIVATE', 'TRANSP:TRANSPARENT']);
    const delta = await call(colleague, `${path}?since=${encodeURIComponent(initial.next)}`);
    expect(delta.status).toBe(200);
    expect(await json(delta)).toMatchObject({ changes: [{ uid: 'visible', deleted: true }] });
    const reset = Changes.parse(await json(await call(colleague, path)));
    expect(reset.changes.some((row) => row.uid === 'visible')).toBe(false);
  });

  test('admin device homes include only owned or explicitly readable shared calendars', async () => {
    const credentials = { username: 'admin-device-abcdefgh', password: 'admin-device-password' };
    const admin: Principal = { ...colleague, userId: peerId, role: 'admin' };
    await unsafeDb().update(member).set({ role: 'admin' }).where(and(eq(member.userId, peerId), eq(member.organizationId, owner.tenantId)));
    await unsafeDb().insert(davLogin).values({ tenantId: owner.tenantId, userId: peerId, name: 'Admin device', username: credentials.username, passwordHash: await Bun.password.hash(credentials.password, { algorithm: 'argon2id' }) });
    const request = async (path: string, method = 'PROPFIND', depth = '0') => {
      const response = await dav.request(path, { method, headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`, Depth: depth } });
      return { status: response.status, text: await response.text() };
    };
    try {
      const owned = await withTenant(owner.tenantId, (tx) => createCalendar(tx, feeds, peerId, { name: 'Admin own' }));
      const unshared = await calendar(), personal = await calendar(), tenant = await calendar(), busyPersonal = await calendar(), busyTenant = await calendar();
      for (const [cal, access, grantee] of [
        [personal, 'read', { type: 'user', userId: peerId }], [tenant, 'read', { type: 'tenant' }],
        [busyPersonal, 'free-busy', { type: 'user', userId: peerId }], [busyTenant, 'free-busy', { type: 'tenant' }],
      ] as const) expect((await call(owner, `/calendars/${cal.id}/shares`, 'POST', { grantee, access })).status).toBe(201);
      const home = `/dav/${credentials.username}/cal/`;
      const listing = await request(home, 'PROPFIND', '1'); expect(listing.status).toBe(207);
      for (const cal of [owned, personal, tenant]) {
        expect(listing.text).toContain(cal.id);
        expect((await request(`${home}${cal.id}/`)).status).toBe(207);
      }
      for (const cal of [unshared, busyPersonal, busyTenant]) {
        expect(listing.text).not.toContain(cal.id);
        expect((await request(`${home}${cal.id}/`)).status).toBe(404);
      }
      // Explicit grants select the home; the admin's effective access still governs listed data.
      const full = await request(`${home}${personal.id}/private.ics`, 'GET'); expect(full.status).toBe(200); expect(full.text).toContain('SUMMARY:Secret');
      expect((await call(admin, `/calendars/${unshared.id}/events/private`)).status).toBe(200);
    } finally {
      await unsafeDb().update(member).set({ role: 'member' }).where(and(eq(member.userId, peerId), eq(member.organizationId, owner.tenantId)));
    }
  });

  test('managers cannot escalate, downgrade or revoke managers, or delete collections', async () => {
    const cal = await calendar(); const grant = await share(cal, 'manage');
    const path = `/calendars/${cal.id}/shares`;
    expect((await call(colleague, path, 'POST', { grantee: { type: 'tenant' }, access: 'manage' })).status).toBe(403);
    expect((await call(colleague, `${path}/${grant.id}`, 'PATCH', { access: 'read' })).status).toBe(403);
    expect((await call(colleague, `${path}/${grant.id}`, 'DELETE')).status).toBe(403);
    expect((await davCall(`${home}${cal.id}/`, 'DELETE')).status).toBe(403);
    const writable = await calendar(); await share(writable, 'write');
    const props = await davCall(`${home}${writable.id}/`, 'PROPPATCH', xml('d:propertyupdate', '<d:set><d:prop><d:displayname>Changed</d:displayname></d:prop></d:set>'));
    expect(props.status).toBe(207); expect(props.text).toContain('403 Forbidden');
    expect(props.text).not.toContain('200 OK');
  });

  test('shares use If-Match, duplicate conflict id, membership validation, audit and RLS', async () => {
    const cal = await calendar(); const grant = await share(cal, 'read'); const path = `/calendars/${cal.id}/shares`;
    const duplicate = await call(owner, path, 'POST', { grantee: { type: 'user', userId: colleague.userId }, access: 'read' });
    expect(duplicate.status).toBe(409); expect(await json(duplicate)).toMatchObject({ id: grant.id });
    expect((await call(owner, `${path}/${grant.id}`, 'PATCH', { access: 'write' }, { 'if-match': 'W/"old"' })).status).toBe(412);
    expect((await call(owner, `${path}/${grant.id}`, 'PATCH', { access: 'write' }, { 'if-match': grant.etag })).status).toBe(200);
    for (const [userId, status] of [[owner.userId, 422], [outsider.userId, 404]] as const) expect((await call(owner, path, 'POST', { grantee: { type: 'user', userId }, access: 'read' })).status).toBe(status);
    expect(await withTenant(outsider.tenantId, (tx) => tx.select().from(calendarShare))).toEqual([]);
    expect((await call(outsider, path)).status).toBe(404);
    const actions = await withTenant(owner.tenantId, (tx) => tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.targetId, grant.id)));
    expect(actions.map((row) => row.action)).toEqual(['share.create', 'share.update']);
    expect(await json(await call(owner, path))).toMatchObject({ items: [{ user: { name: 'Colleague', email: 'Colleague@sharing.test'.toLowerCase() } }] });
  });

  test('imported calendar permits read but rejects write and manage grants', async () => {
    const [account] = await unsafeDb().insert(calendarAccount).values({ tenantId: owner.tenantId, ownerUserId: owner.userId, provider: 'ics', displayName: 'Imported' }).returning();
    if (!account) throw new Error('No account');
    const [cal] = await unsafeDb().insert(sourceCalendar).values({ tenantId: owner.tenantId, accountId: account.id, providerCalendarId: 'imported', name: 'Imported' }).returning();
    if (!cal) throw new Error('No calendar');
    const change = upsertOf(cal, 'imported', parseCalendar(payload('imported')).resources[0]!, 'complete');
    await withTenant(owner.tenantId, (tx) => recordChanges(tx, [change]));
    const grant = await share(cal, 'read');
    expect((await call(colleague, `/calendars/${cal.id}/events`)).status).toBe(200);
    expect((await davCall(`${home}${cal.id}/`, 'REPORT', xml('c:calendar-query'))).status).toBe(207);
    for (const access of ['write', 'manage']) {
      const response = await call(owner, `/calendars/${cal.id}/shares/${grant.id}`, 'PATCH', { access });
      expect(response.status).toBe(422); expect(await json(response)).toMatchObject({ type: `https://supercal.dev/problems/${access === 'write' ? 'calendar-read-only' : 'calendar-not-hosted'}` });
    }
  });

  test('writable connected calendars allow write grants, retain them while read-only, and never allow manage', async () => {
    const [account] = await unsafeDb().insert(calendarAccount).values({ tenantId: owner.tenantId, ownerUserId: owner.userId, provider: 'google', displayName: 'Writable' }).returning();
    const capabilities = { incremental: 'delta', push: false, write: true };
    const [cal] = await unsafeDb().insert(sourceCalendar).values({ tenantId: owner.tenantId, accountId: account!.id, providerCalendarId: 'writable', name: 'Writable', capabilities }).returning();
    if (!cal) throw new Error('No calendar');
    await withTenant(owner.tenantId, (tx) => recordChanges(tx, [upsertOf(cal, 'private', parseCalendar(payload()).resources[0]!, 'complete')]));
    const grant = await share(cal, 'write');
    expect(await withTenant(owner.tenantId, (tx) => effectiveAccess(tx, colleague, cal.id))).toBe('write');
    const path = `/calendars/${cal.id}`;
    expect(await json(await call(colleague, `${path}/events/private`))).toMatchObject({ title: 'Secret' });
    expect((await call(owner, `${path}/shares/${grant.id}`, 'PATCH', { access: 'manage' })).status).toBe(422);
    await unsafeDb().update(sourceCalendar).set({ capabilities: { ...capabilities, write: false } }).where(eq(sourceCalendar.id, cal.id));
    expect(await withTenant(owner.tenantId, (tx) => effectiveAccess(tx, colleague, cal.id))).toBe('read');
    expect((await call(owner, `${path}/shares`, 'POST', { grantee: { type: 'tenant' }, access: 'write' })).status).toBe(422);
    expect(await json(await call(colleague, `${path}/events/private`))).toMatchObject({ title: 'Busy' });
    expect((await call(colleague, `${path}/events`, 'POST', jsEvent)).status).toBe(403);
    const [stored] = await unsafeDb().select().from(calendarShare).where(eq(calendarShare.calendarId, cal.id));
    expect(stored?.access).toBe('write');
    await unsafeDb().update(sourceCalendar).set({ capabilities }).where(eq(sourceCalendar.id, cal.id));
    expect(await withTenant(owner.tenantId, (tx) => effectiveAccess(tx, colleague, cal.id))).toBe('write');
    expect(await json(await call(colleague, `${path}/events/private`))).toMatchObject({ title: 'Secret' });
  });

  test('revocation affects the next REST and DAV request; read to write invalidates sync token', async () => {
    const cal = await calendar(), grant = await share(cal, 'read'), path = `${home}${cal.id}/`;
    const initial = await davCall(path, 'REPORT', sync()); expect(initial.status).toBe(207); const token = tokenOf(initial.text); expect(token).toContain('.r/');
    const denied = await davCall(`${path}new.ics`, 'PUT', payload('denied')); expect(denied.status).toBe(403); expect(denied.text).toContain('need-privileges');
    expect((await call(owner, `/calendars/${cal.id}/shares/${grant.id}`, 'PATCH', { access: 'write' })).status).toBe(200);
    const expired = await davCall(path, 'REPORT', sync(token)); expect(expired.status).toBe(403); expect(expired.text).toContain('valid-sync-token');
    expect((await davCall(`${path}new.ics`, 'PUT', payload('new'))).status).toBe(201);
    expect((await call(owner, `/calendars/${cal.id}/events/new`)).status).toBe(200);
    expect((await call(owner, `/calendars/${cal.id}/shares/${grant.id}`, 'DELETE')).status).toBe(204);
    expect((await call(colleague, `/calendars/${cal.id}/events`)).status).toBe(403);
    expect((await davCall(path)).status).toBe(404);
    expect((await davCall(`${path}new.ics`, 'GET')).status).toBe(404);
    expect((await davCall(home, 'PROPFIND', undefined, { Depth: '1' })).text).not.toContain(cal.id);
  });

  test('free-busy hides inaccessible ids and bounds requests; only user collections advertise REPORT', async () => {
    const cal = await calendar(); await share(cal, 'free-busy');
    const privateCal = await calendar(), gone = await calendar(), missing = newId('cal');
    await share(gone, 'read'); await call(owner, `/calendars/${gone.id}`, 'DELETE');
    const input = { from: '2026-11-09T00:00:00Z', to: '2026-11-10T00:00:00Z', calendarIds: [cal.id, privateCal.id, gone.id, missing] };
    const response = await call(colleague, '/free-busy', 'POST', input); expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ calendars: { [cal.id]: { busy: [{ start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z', status: 'busy' }], truncated: false }, [privateCal.id]: { error: 'not-accessible' }, [gone.id]: { error: 'not-accessible' }, [missing]: { error: 'not-accessible' } } });
    for (const patch of [{ to: input.from }, { to: '2027-01-11T00:00:00Z' }, { from: '2526-11-09T00:00:00Z', to: '2526-11-10T00:00:00Z' }, { calendarIds: Array.from({ length: 51 }, () => cal.id) }]) expect((await call(colleague, '/free-busy', 'POST', { ...input, ...patch })).status).toBe(400);
    expect((await davCall(home, 'PROPFIND', undefined, { Depth: '1' })).text).not.toContain(cal.id);
    const read = await calendar(); await share(read, 'read');
    expect((await davCall(`${home}${read.id}/`)).text).toContain('free-busy-query');
    const report = await davCall(`${home}${read.id}/`, 'REPORT', xml('c:free-busy-query', '<c:time-range start="20261109T000000Z" end="20261110T000000Z"/>'));
    expect(report.status).toBe(200); expect(report.text).toContain('FREEBUSY;FBTYPE=BUSY:20261109T090000Z/20261109T100000Z');
    for (const range of ['', '<c:time-range start="nonsense"/>', '<c:time-range start="20261110T000000Z" end="20261109T000000Z"/>', '<c:time-range start="20261109T000000Z" end="20270111T000000Z"/>', '<c:time-range start="25261109T000000Z" end="25261110T000000Z"/>']) expect((await davCall(`${home}${read.id}/`, 'REPORT', xml('c:free-busy-query', range))).status).toBe(400);
  });

  test('member removal hook deletes personal grants before re-invitation', async () => {
    const cal = await calendar(); await share(cal, 'read');
    expect((await authCall('/organization/leave', colleagueCookie, { organizationId: owner.tenantId })).status).toBe(404);
    expect((await authCall('/organization/remove-member', ownerCookie, { memberIdOrEmail: 'colleague@sharing.test', organizationId: owner.tenantId })).status).toBe(200);
    const remaining = await unsafeDb().select().from(calendarShare).where(eq(calendarShare.granteeUserId, colleague.userId)); expect(remaining).toEqual([]);
    expect(await unsafeDb().select().from(davLogin).where(eq(davLogin.userId, colleague.userId))).toEqual([]);
    const invite = await authCall('/organization/invite-member', ownerCookie, { email: 'colleague@sharing.test', role: 'member', organizationId: owner.tenantId }); expect(invite.status).toBe(200);
    const invitation = z.object({ id: z.string() }).parse(await json(invite));
    expect((await authCall('/organization/accept-invitation', colleagueCookie, { invitationId: invitation.id })).status).toBe(200);
    expect(await withTenant(owner.tenantId, (tx) => effectiveAccess(tx, colleague, cal.id))).toBeNull();
  });
});
