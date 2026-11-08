import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSEvent, JSCalendar, parseCalendar, serializeCalendar } from '@supercal/core';
import { auditLog, calendarAccount, changesSince, closeDb, connectDb, member, migrate, organization, recordChanges, resource, sourceCalendar, sourceObject, systemSetting, user, withTenant, type TenantId, type SourceCalendarId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { Calendar } from '../src/api/calendars.ts';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { writeObject } from '../src/hosted/objects.ts';
import { upsertOf } from '../src/sync/changes.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const principal: Principal = { kind: 'user', userId: `events_${crypto.randomUUID()}`, tenantId, role: 'member', via: 'session', isOperator: false };
const inject = createMiddleware<ApiEnv>(async (c, next) => { c.set('principal', principal); await next(); });
let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let fixture: ReturnType<typeof testAuth>;
let app: ReturnType<typeof createApi>;
const EventList = z.object({ items: z.array(z.object({ etag: z.string(), event: JSCalendar })), nextCursor: z.string().nullable() });
const ChangeList = z.object({ changes: z.array(z.object({ uid: z.string(), deleted: z.boolean(), etag: z.string().optional(), event: JSCalendar.optional() })), next: z.string(), hasMore: z.boolean() });
const Occurrences = z.object({ items: z.array(z.object({ uid: z.string(), recurrenceId: z.string(), start: z.string(), end: z.string(), title: z.string() })), truncated: z.boolean() });
const SplitResult = z.object({ original: z.object({ etag: z.string(), event: JSEvent }), next: z.object({ etag: z.string(), event: JSEvent }) });
const ImportResult = z.object({ created: z.number(), updated: z.number(), skipped: z.number(), failed: z.array(z.object({ uid: z.string(), reason: z.string() })) });
const example = { '@type': 'Event', version: '2.0', title: 'Team sync', start: '2026-11-12T09:00:00', timeZone: 'Europe/Madrid', duration: 'PT1H', recurrenceRule: { frequency: 'weekly', until: '2027-01-14T09:00:00' } };
const call = (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => app.request(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(data !== undefined && { body: JSON.stringify(data) }) });
async function calendar() {
  const response = await call('/calendars', 'POST', { name: 'Events' }); expect(response.status).toBe(201);
  return Calendar.parse(await response.json()).id;
}
async function rowFor(id: SourceCalendarId, uid: string) { const [row] = await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, id), eq(resource.uid, uid))); if (!row?.data) throw new Error('No event'); return { ...row, data: row.data }; }
async function storedCalendar(id: SourceCalendarId) { const [row] = await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.id, id)); if (!row) throw new Error('No calendar'); return row; }

describe.skipIf(!testDatabaseUrl)('events API', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('events'); await migrate(scratch.url); connectDb(scratch.url); fixture = testAuth('invite', scratch.url);
    app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }, inject);
    const now = new Date();
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'Events', slug: tenantId, createdAt: now });
    await unsafeDb().insert(user).values({ id: principal.userId, name: 'Events', email: 'events@example.test', updatedAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: principal.userId, role: 'member', createdAt: now });
  });
  afterAll(async () => { await fixture?.close(); await closeDb(); await scratch?.drop(); });

  test('worked create and occurrence patch examples run as written, with vendor JSPROP and server metadata', async () => {
    const id = await calendar();
    const created = await call(`/calendars/${id}/events`, 'POST', { ...example, 'example.com:tag': { nested: [1, 'two'] }, created: '1999-01-01T00:00:00Z', updated: '1999-01-01T00:00:00Z', sequence: 99, prodId: 'client' });
    expect(created.status).toBe(201);
    const event = JSEvent.parse(await created.json());
    expect(event.sequence).toBe(0); expect(typeof event.uid).toBe('string'); expect(typeof event.updated).toBe('string'); expect(typeof event.created).toBe('string');
    expect(event.prodId).toBe('-//Supercal//EN'); expect(event.created).not.toBe('1999-01-01T00:00:00Z'); expect(event.updated).not.toBe('1999-01-01T00:00:00Z');
    const path = `/calendars/${id}/events/${event.uid}`;
    expect(created.headers.get('location')).toBe(`/api/v1${path}`);
    const [object] = await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, id));
    expect(object?.payload).toContain('DTSTART;TZID=Europe/Madrid:20261112T090000'); expect(object?.payload).toContain('RRULE:FREQ=WEEKLY;UNTIL=20270114T080000Z');
    expect(object?.payload).toContain('JSPROP;JSPTR="example.com:tag"');
    const missing = await call(path, 'PATCH', { 'recurrenceOverrides/2026-11-19T09:00:00': { start: '2026-11-19T10:00:00' } }, { 'if-match': created.headers.get('etag')! });
    expect(missing.status).toBe(400); expect(await missing.json()).toMatchObject({ errors: [{ path: 'recurrenceOverrides/2026-11-19T09:00:00' }] });
    const overrides = { '2026-11-19T09:00:00': { start: '2026-11-19T10:00:00' }, '2026-11-26T09:00:00': { excluded: true } };
    const prepared = await call(path, 'PATCH', { recurrenceOverrides: {} }, { 'if-match': created.headers.get('etag')! }); expect(prepared.status).toBe(200);
    const patched = await call(path, 'PATCH', Object.fromEntries(Object.entries(overrides).map(([date, value]) => [`recurrenceOverrides/${date}`, value])), { 'if-match': prepared.headers.get('etag')! });
    expect(patched.status).toBe(200); expect(JSEvent.parse(await patched.json())['example.com:tag']).toEqual({ nested: [1, 'two'] });
    const occurrences = await call(`/calendars/${id}/occurrences?from=2026-11-12T00:00:00Z&to=2026-12-01T00:00:00Z`);
    expect(occurrences.status).toBe(200);
    expect(Occurrences.parse(await occurrences.json()).items.map((o) => o.start)).toEqual(['2026-11-12T08:00:00Z','2026-11-19T09:00:00Z']);
    const stored = await rowFor(id, event.uid!); const ics = serializeCalendar({ props: [], resources: [stored.data] });
    expect(ics).toContain('RECURRENCE-ID;TZID=Europe/Madrid:20261119T090000'); expect(ics).toContain('EXDATE;TZID=Europe/Madrid:20261126T090000');
    const read = await call(path); expect(read.headers.get('etag')).toBe(patched.headers.get('etag'));
    expect((await call(path, 'GET', undefined, { 'if-none-match': `W/${patched.headers.get('etag')}` })).status).toBe(304);
  });
  test('rejections identify the 2.0 replacement and invalid version and zone', async () => {
    const id = await calendar();
    for (const [data, pointer] of [[{ recurrenceRules: [] }, 'recurrenceRules'], [{ version: '1.0' }, 'version'], [{ timeZone: 'Mars/Olympus' }, 'timeZone']] as const) {
      const response = await call(`/calendars/${id}/events`, 'POST', { ...example, ...data }); expect(response.status).toBe(400);
      const problem = z.object({ errors: z.array(z.object({ path: z.string(), message: z.string() })) }).parse(await response.json());
      expect(problem.errors[0]?.path).toBe(pointer); if (pointer === 'recurrenceRules') expect(problem.errors[0]?.message).toContain('recurrenceRule');
    }
  });
  test('sequence tracks timing changes and stale cross-protocol If-Match is refused', async () => {
    const id = await calendar(), uid = 'cross/protocol@example.test', path = `/calendars/${id}/events/${encodeURIComponent(uid)}`;
    const first = await call(path, 'PUT', { ...example, uid }); expect(first.status).toBe(201);
    const title = await call(path, 'PATCH', { title: 'Renamed' }, { 'if-match': first.headers.get('etag')! }); expect(title.status).toBe(200); expect(JSEvent.parse(await title.json()).sequence).toBe(0);
    const moved = await call(path, 'PATCH', { start: '2026-11-12T10:00:00' }, { 'if-match': title.headers.get('etag')! }); expect(moved.status).toBe(200); expect(JSEvent.parse(await moved.json()).sequence).toBe(1);
    const stored = await rowFor(id, uid), cal = await storedCalendar(id);
    await withTenant(tenantId, (tx) => writeObject(tx, cal, { objectName: stored.objectName!, payload: serializeCalendar({ props: [], resources: [stored.data] }).replace('SUMMARY:Renamed', 'SUMMARY:CalDAV edit') }));
    expect((await call(path, 'PATCH', { title: 'Stale' }, { 'if-match': moved.headers.get('etag')! })).status).toBe(412);
    expect((await call(path, 'PUT', { ...example, uid: 'wrong' })).status).toBe(400);
    expect((await call(`/calendars/${id}/events`, 'POST', { ...example, uid })).status).toBe(409);
  });
  test('list pagination filters coarse spans and occurrences enforce their window and item caps', async () => {
    const id = await calendar(), base = `/calendars/${id}`;
    for (const uid of ['a', 'b', 'c']) expect((await call(`${base}/events/${uid}`, 'PUT', { ...example, uid, recurrenceRule: undefined })).status).toBe(201);
    const page = EventList.parse(await (await call(`${base}/events?limit=2`)).json()); expect(page.items.map((item) => item.event.uid)).toEqual(['a','b']);
    const next = EventList.parse(await (await call(`${base}/events?limit=2&cursor=${page.nextCursor}`)).json()); expect(next.items.map((item) => item.event.uid)).toEqual(['c']); expect(next.nextCursor).toBeNull();
    const outside = EventList.parse(await (await call(`${base}/events?from=2027-01-01T00:00:00Z&to=2027-02-01T00:00:00Z`)).json()); expect(outside.items).toHaveLength(0);
    expect((await call(`${base}/occurrences?from=2026-01-01T00:00:00Z&to=2028-01-01T00:00:00Z`)).status).toBe(400);
    expect((await call(`${base}/events/fast`, 'PUT', { ...example, uid: 'fast', timeZone: undefined, duration: 'PT1S', recurrenceRule: { frequency: 'minutely' } })).status).toBe(201);
    const expanded = Occurrences.parse(await (await call(`${base}/occurrences?from=2026-11-12T00:00:00Z&to=2026-11-20T00:00:00Z`)).json()); expect(expanded.items).toHaveLength(5000); expect(expanded.truncated).toBe(true);
  });
  test('changes resumes create/update/delete, pages, and expires malformed, old-epoch and below-floor tokens', async () => {
    const id = await calendar(), base = `/calendars/${id}`;
    const first = ChangeList.parse(await (await call(`${base}/changes`)).json());
    await call(`${base}/events/a`, 'PUT', { ...example, uid: 'a' }); await call(`${base}/events/b`, 'PUT', { ...example, uid: 'b' });
    const page = ChangeList.parse(await (await call(`${base}/changes?since=${first.next}&limit=1`)).json()); expect(page.hasMore).toBe(true); expect(page.changes[0]?.uid).toBe('a');
    await call(`${base}/events/a`, 'PATCH', { title: 'Changed' }); await call(`${base}/events/b`, 'DELETE');
    const changed = ChangeList.parse(await (await call(`${base}/changes?since=${page.next}`)).json()); expect(changed.changes).toMatchObject([{ uid: 'a', deleted: false }, { uid: 'b', deleted: true }]);
    const full = ChangeList.parse(await (await call(`${base}/changes`)).json()); expect(full.changes.map((r) => r.uid)).toEqual(['a']);
    expect((await call(`${base}/changes?since=bad`)).status).toBe(410);
    await unsafeDb().update(sourceCalendar).set({ syncEpoch: 1 }).where(eq(sourceCalendar.id, id)); expect((await call(`${base}/changes?since=${changed.next}`)).status).toBe(410);
    const current = ChangeList.parse(await (await call(`${base}/changes`)).json());
    const floor = (await withTenant(tenantId, async (tx) => changesSince(tx, [(await storedCalendar(id)).id], 0n, 10))).maxSeq + 1n;
    await unsafeDb().update(systemSetting).set({ value: Number(floor) }).where(eq(systemSetting.key, 'tombstone_floor'));
    expect((await call(`${base}/changes?since=${current.next}`)).status).toBe(410);
    await unsafeDb().update(systemSetting).set({ value: 0 }).where(eq(systemSetting.key, 'tombstone_floor'));
  });
  test('read imported calendars and detached Event/Group in get, list and changes; reject writes', async () => {
    const [account] = await unsafeDb().insert(calendarAccount).values({ tenantId, ownerUserId: principal.userId, provider: 'ics', displayName: 'Imported' }).returning();
    const [cal] = await unsafeDb().insert(sourceCalendar).values({ tenantId, accountId: account!.id, providerCalendarId: 'external', name: 'Imported' }).returning();
    const imported = parseCalendar('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:imported\r\nDTSTART:20261112T090000Z\r\nSUMMARY:Imported\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n').resources[0]!;
    await withTenant(tenantId, (tx) => recordChanges(tx, [upsertOf(cal!, imported.uid, imported, 'complete')]));
    expect((await call(`/calendars/${cal!.id}/events/imported`)).status).toBe(200); expect((await call(`/calendars/${cal!.id}/events`, 'POST', example)).status).toBe(409);
    const id = await calendar(), calendarRow = await storedCalendar(id);
    const detached = (uid: string, days: number[]) => ['BEGIN:VCALENDAR','VERSION:2.0',...days.flatMap((day) => ['BEGIN:VEVENT',`UID:${uid}`,`RECURRENCE-ID:202611${day}T090000Z`,`DTSTART:202611${day}T100000Z`,'END:VEVENT']),'END:VCALENDAR',''].join('\r\n');
    for (const [uid, days] of [['single', [12]], ['group', [12, 19]]] as const) await withTenant(tenantId, (tx) => writeObject(tx, calendarRow, { objectName: `${uid}.ics`, payload: detached(uid, [...days]) }));
    const one = JSCalendar.parse(await (await call(`/calendars/${id}/events/single`)).json()); expect(one).toMatchObject({ '@type': 'Event', recurrenceId: '2026-11-12T09:00:00', recurrenceIdTimeZone: 'Etc/UTC' });
    const group = JSCalendar.parse(await (await call(`/calendars/${id}/events/group`)).json()); expect(group['@type']).toBe('Group');
    expect(EventList.parse(await (await call(`/calendars/${id}/events`)).json()).items.map((r) => r.event['@type'])).toEqual(['Group','Event']);
    expect(ChangeList.parse(await (await call(`/calendars/${id}/changes`)).json()).changes.map((r) => r.event?.['@type'])).toEqual(['Event','Group']);
    expect((await call(`/calendars/${id}/events/group`, 'PATCH', { title: 'No' })).status).toBe(409);
  });
  test('split example is atomic, applies the patch last and rejects UID conflict', async () => {
    const id = await calendar(), base = `/calendars/${id}/events`;
    const first = await call(`${base}/series`, 'PUT', example); expect(first.status).toBe(201);
    const result = await call(`${base}/series/split`, 'POST', { at: '2026-12-03T09:00:00', uid: 'next', patch: { title: 'Team sync (new time)', start: '2026-12-03T10:00:00' } }, { 'if-match': first.headers.get('etag')! });
    expect(result.status).toBe(201); const parts = SplitResult.parse(await result.json());
    expect(parts.original.event.recurrenceRule?.until).toBe('2026-11-26T09:00:00'); expect(parts.next.event.start).toBe('2026-12-03T10:00:00');
    const originalTag = (await call(`${base}/series`)).headers.get('etag');
    expect((await call(`${base}/series/split`, 'POST', { at: '2026-11-19T09:00:00', uid: 'next' })).status).toBe(409);
    expect((await call(`${base}/series`)).headers.get('etag')).toBe(originalTag);
  });
  test('import/export groups each UID, isolates invalid events and skip allocates no sequence numbers', async () => {
    const id = await calendar(), base = `/calendars/${id}`;
    await call(`${base}/events/one`, 'PUT', { ...example, 'example.com:tag': 'exported' });
    const exported = await call(`${base}/export.ics`); expect(exported.headers.get('content-type')).toContain('text/calendar');
    const ics = await exported.text(), second = await calendar();
    const importIcs = (raw: string, conflict = 'skip') => app.request(`/api/v1/calendars/${second}/import?onConflict=${conflict}`, { method: 'POST', headers: { 'content-type': 'text/calendar' }, body: raw });
    const created = await importIcs(ics); expect(created.status).toBe(200); expect(ImportResult.parse(await created.json())).toMatchObject({ created: 1, failed: [] });
    const before = (await withTenant(tenantId, async (tx) => changesSince(tx, [(await storedCalendar(second)).id], 0n, 500))).maxSeq;
    expect(ImportResult.parse(await (await importIcs(ics)).json())).toMatchObject({ skipped: 1, created: 0 });
    expect((await withTenant(tenantId, async (tx) => changesSince(tx, [(await storedCalendar(second)).id], before, 500))).rows).toHaveLength(0);
    const invalid = ics.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:bad\r\nSUMMARY:Missing timing\r\nEND:VEVENT\r\nEND:VCALENDAR');
    expect(ImportResult.parse(await (await importIcs(invalid, 'replace')).json())).toMatchObject({ updated: 1, failed: [{ uid: 'bad', reason: 'invalid-calendar-data' }] });
    expect((await importIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n')).status).toBe(422);
    expect((await importIcs('x'.repeat(8 * 1024 * 1024 + 1))).status).toBe(413);
    const audit = await unsafeDb().select().from(auditLog).where(eq(auditLog.targetId, second));
    expect(audit.filter((row) => row.action === 'calendar.import').every((row) => !JSON.stringify(row.data).includes('Team sync'))).toBe(true);
  });
});
