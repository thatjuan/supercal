import { z } from 'zod';
import { Calendar } from '../src/api/calendars.ts';
import { Problem } from '../src/api/kit/problem.ts';
import { normalizers, parseCalendar, summary } from '@supercal/core';
import { auditLog, calendarAccount, changesSince, closeDb, connectDb, feed, member, migrate, newId, organization, publication, publicationSource, recordChanges, resource, sourceCalendar, sourceObject, syncTarget, user, withTenant, type SourceCalendar, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { createFeedService } from '../src/feeds/service.ts';
import { createCalendar, getOrCreateHostedAccount } from '../src/hosted/calendars.ts';
import { deleteObject, HostedWriteError, writeObject } from '../src/hosted/objects.ts';
import { enabledPublications, renderIcs } from '../src/ics/render.ts';
import { createLogger } from '../src/log.ts';
import { upsertOf } from '../src/sync/changes.ts';
import { registerMaintenance, runMaintenance } from '../src/sync/maintenance.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';
import { eventIcs } from './dav/fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const otherTenant = `org_${crypto.randomUUID()}` as TenantId;
const alice: Principal = { kind: 'user', userId: `alice_${crypto.randomUUID()}`, tenantId, role: 'member', via: 'session', isOperator: false };
let principal = alice;
const inject = createMiddleware<ApiEnv>(async (c, next) => { c.set('principal', principal); await next(); });
const feeds = createFeedService(testSecrets);
const log = createLogger({}, () => {});
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let app: ReturnType<typeof createApi>;
const payload = (uid: string, title = 'Hosted') => eventIcs(uid, ['DTSTART:20261110T090000Z', 'DURATION:PT1H', `SUMMARY:${title}`]);
const create = (name = 'Hosted') => withTenant(tenantId, (tx) => createCalendar(tx, feeds, alice.userId, { name }));
const write = (calendar: SourceCalendar, name: string, uid: string) => withTenant(tenantId, (tx) => writeObject(tx, calendar, { objectName: name, payload: payload(uid) }));
async function rejected(work: Promise<unknown>, code: HostedWriteError['code']) {
  try { await work; throw new Error('Expected rejection'); } catch (error) {
    expect(error).toBeInstanceOf(HostedWriteError);
    if (!(error instanceof HostedWriteError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}
async function call(path: string, method = 'GET', body?: unknown, etag?: string) {
  return app.request(`/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(etag && { 'if-match': etag }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}
async function maintenance(target: 'renormalize' | 'purge-hosted-calendars') {
  return runMaintenance({ id: newId('tgt'), tenantId: null, kind: 'maintenance', target, owner: 'test', version: 1, wakeGeneration: 0, attempts: 1 }, log);
}
async function storedCalendar(id: SourceCalendar['id']) {
  const [row] = await unsafeDb().select().from(sourceCalendar).where(eq(sourceCalendar.id, id));
  return row;
}

describe.skipIf(!testDatabaseUrl)('hosted calendars', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('hosted');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }, inject);
    const now = new Date();
    for (const id of [tenantId, otherTenant]) await unsafeDb().insert(organization).values({ id, name: id, slug: id, createdAt: now });
    await unsafeDb().insert(user).values({ id: alice.userId, name: 'Alice', email: 'alice@hosted.test', updatedAt: now });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: alice.userId, role: 'member', createdAt: now });
  });
  afterAll(async () => { await fixture?.close(); await closeDb(); await scratch?.drop(); });

  test('concurrent uniqueness: separate transactions cannot create one UID at two names', async () => {
    const calendar = await create();
    const connections = new Set<number>();
    const ready = Promise.withResolvers<void>();
    const contender = (objectName: string) => withTenant(tenantId, async (tx) => {
      const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      if (!connection) throw new Error('Missing connection');
      connections.add(connection.pid);
      if (connections.size === 2) ready.resolve();
      await ready.promise;
      return writeObject(tx, calendar, { objectName, payload: payload('race') });
    });
    const results = await Promise.allSettled([contender('a.ics'), contender('b.ics')]);
    expect(connections.size).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled') === 0 ? 'a.ics' : 'b.ics';
    const loser = results.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({ code: 'uid-conflict', conflictObjectName: winner });
  });

  test('object preconditions share the revision ETag and an object cannot change UID', async () => {
    const calendar = await create();
    const first = await write(calendar, 'a.ics', 'preconditions');
    expect(first.created).toBe(true);
    for (const input of [{ objectName: 'a.ics', ifNoneMatch: '*' as const }, { objectName: 'a.ics', ifMatch: '"stale"' }, { objectName: 'absent.ics', ifMatch: first.etag }])
      await rejected(withTenant(tenantId, (tx) => writeObject(tx, calendar, { ...input, payload: payload('preconditions') })), 'precondition-failed');
    await rejected(write(calendar, 'a.ics', 'different'), 'uid-conflict');
    await rejected(withTenant(tenantId, (tx) => deleteObject(tx, calendar, { objectName: 'a.ics', ifMatch: '"stale"' })), 'precondition-failed');
    expect(await withTenant(tenantId, (tx) => writeObject(tx, calendar, { objectName: 'a.ics', payload: payload('preconditions', 'Updated'), ifMatch: first.etag }))).toMatchObject({ created: false });
    await rejected(withTenant(tenantId, (tx) => deleteObject(tx, calendar, { objectName: 'absent.ics' })), 'not-found');
  });

  test('payload fidelity and insignificant folding changes preserve ETags and sequences', async () => {
    const calendar = await create();
    const raw = payload('fidelity').replace('SUMMARY:Hosted', 'SUMMARY:Unusual\r\n\tfolding\r\nX-PRIVATE;X-PARAM=odd:verbatim');
    const first = await withTenant(tenantId, (tx) => writeObject(tx, calendar, { objectName: 'raw.ics', payload: raw }));
    const [object] = await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
    expect(object?.payload).toBe(raw);
    const before = await withTenant(tenantId, (tx) => changesSince(tx, [calendar.id], 0n, 10));
    const unfolded = raw.replace('Unusual\r\n\tfolding', 'Unusualfolding');
    const second = await withTenant(tenantId, (tx) => writeObject(tx, calendar, { objectName: 'raw.ics', payload: unfolded, ifMatch: first.etag }));
    expect(second.etag).toBe(first.etag);
    expect((await withTenant(tenantId, (tx) => changesSince(tx, [calendar.id], before.maxSeq, 10))).rows).toHaveLength(0);
    const [updated] = await unsafeDb().select().from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
    expect(updated?.payload).toBe(unfolded);
  });

  test('epoch changes only when a tombstoned UID moves to another object name', async () => {
    const calendar = await create();
    await write(calendar, 'a.ics', 'epoch');
    await withTenant(tenantId, (tx) => deleteObject(tx, calendar, { objectName: 'a.ics' }));
    const [tombstone] = await unsafeDb().select().from(resource).where(eq(resource.sourceCalendarId, calendar.id));
    expect(tombstone).toMatchObject({ deleted: true, objectName: 'a.ics' });
    await write(calendar, 'a.ics', 'epoch');
    expect((await storedCalendar(calendar.id))?.syncEpoch).toBe(0);
    await withTenant(tenantId, (tx) => deleteObject(tx, calendar, { objectName: 'a.ics' }));
    await write(calendar, 'b.ics', 'epoch');
    expect((await storedCalendar(calendar.id))?.syncEpoch).toBe(1);
  });

  test('pipeline reach: hosted events flow through ICS, change reads and virtual merge with imported copies', async () => {
    const calendar = await create('Hosted pipeline');
    const [link] = await unsafeDb().select().from(publicationSource).where(eq(publicationSource.sourceCalendarId, calendar.id));
    if (!link) throw new Error('No passthrough');
    await withTenant(tenantId, (tx) => feeds.updatePublication(tx, alice, link.publicationId, { enabled: true }));
    await write(calendar, 'pipeline.ics', 'shared-uid');
    const changes = await withTenant(tenantId, (tx) => changesSince(tx, [calendar.id], 0n, 10));
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]?.objectName).toBe('pipeline.ics');
    const [account] = await unsafeDb().insert(calendarAccount).values({ tenantId, ownerUserId: alice.userId, provider: 'ics', displayName: 'Imported' }).returning();
    if (!account) throw new Error('No account');
    const [imported] = await unsafeDb().insert(sourceCalendar).values({ tenantId, accountId: account.id, providerCalendarId: 'imported', name: 'Imported' }).returning();
    if (!imported) throw new Error('No imported calendar');
    const data = parseCalendar(payload('shared-uid', 'Imported copy').replace('SUMMARY:', 'SEQUENCE:2\r\nSUMMARY:')).resources[0];
    if (!data) throw new Error('No parsed event');
    await withTenant(tenantId, (tx) => recordChanges(tx, [upsertOf(imported, data.uid, data, 'complete')]));
    const [target] = await unsafeDb().select().from(feed).where(eq(feed.id, (await unsafeDb().select().from(publication).where(eq(publication.id, link.publicationId)))[0]!.feedId));
    if (!target) throw new Error('No feed');
    const virtual = await withTenant(tenantId, (tx) => feeds.createPublication(tx, alice, target.id, { kind: 'virtual', name: 'Merged', sources: [{ calendarId: calendar.id }, { calendarId: imported.id }] }));
    const publications = await withTenant(tenantId, (tx) => enabledPublications(tx, target.id));
    const render = (ids: string[]) => withTenant(tenantId, (tx) => renderIcs(tx, testSecrets, { feed: target, publications: publications.filter((p) => ids.includes(p.id)), combined: false }));
    const own = parseCalendar(await render([link.publicationId]));
    expect(own.resources[0]?.uid).toBe('shared-uid');
    expect(summary(own.resources[0]!.master!)).toBe('Hosted');
    const merged = parseCalendar(await render([virtual.id]));
    expect(merged.resources).toHaveLength(1);
    expect(summary(merged.resources[0]!.master!)).toBe('Imported copy');
  });

  test('maintenance rebuilds hosted old-version rows without scheduler targets', async () => {
    const calendar = await create();
    await write(calendar, 'old.ics', 'old');
    await unsafeDb().update(sourceObject).set({ normalizerVersion: 0, payload: payload('old', 'Rebuilt') }).where(eq(sourceObject.sourceCalendarId, calendar.id));
    await write(calendar, 'interrupted.ics', 'interrupted');
    await unsafeDb().update(sourceObject).set({ normalizerVersion: 0, dirty: true }).where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, 'interrupted.ics')));
    await maintenance('renormalize');
    const [object] = await unsafeDb().select().from(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, 'old.ics')));
    expect(object).toMatchObject({ normalizerVersion: normalizers.ical?.version, dirty: false });
    const [rebuilt] = await unsafeDb().select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, 'old')));
    expect(summary(rebuilt!.data!.master!)).toBe('Rebuilt');
    expect(rebuilt?.objectName).toBe('old.ics');
    const [interrupted] = await unsafeDb().select().from(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, 'interrupted.ics')));
    expect(interrupted).toMatchObject({ normalizerVersion: normalizers.ical?.version, dirty: false });
    await unsafeDb().update(sourceObject).set({ normalizerVersion: 0, payload: 'broken iCalendar' })
      .where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, 'old.ics')));
    await maintenance('renormalize');
    const [lastGood] = await unsafeDb().select().from(resource)
      .where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, 'old')));
    expect(lastGood).toMatchObject({ completeness: 'incomplete', objectName: 'old.ics' });
    expect(summary(lastGood!.data!.master!)).toBe('Rebuilt');
  });

  test('calendar API, hiding, lifecycle, isolation and 30-day purge', async () => {
    const created = await call('/calendars', 'POST', { name: 'API hosted', color: '#123abc', description: 'Personal' });
    expect(created.status).toBe(201);
    const calendar = Calendar.parse(await created.json());
    expect(calendar).toMatchObject({ kind: 'hosted', accountId: null, timezone: 'UTC' });
    const stored = await storedCalendar(calendar.id);
    if (!stored) throw new Error('No calendar');
    const allAccounts = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(await (await call('/accounts')).json());
    expect(allAccounts.items.some((account) => account.id === stored.accountId)).toBe(false);
    expect((await call(`/accounts/${stored.accountId}`)).status).toBe(404);
    expect(await unsafeDb().select().from(syncTarget).where(inArray(syncTarget.targetId, [stored.accountId, stored.id]))).toHaveLength(0);
    const accounts = await Promise.all([withTenant(tenantId, (tx) => getOrCreateHostedAccount(tx, alice.userId)), withTenant(tenantId, (tx) => getOrCreateHostedAccount(tx, alice.userId))]);
    expect(accounts[0]?.id).toBe(accounts[1]?.id);
    const pubId = calendar.publicationIds[0];
    if (!pubId) throw new Error('No publication');
    const [pub] = await unsafeDb().select().from(publication).where(eq(publication.id, pubId));
    expect(pub?.enabled).toBe(false);
    await withTenant(tenantId, (tx) => feeds.updatePublication(tx, alice, pubId, { enabled: true }));
    await write(stored, 'retained.ics', 'retained');
    expect((await call(`/calendars/${calendar.id}`, 'PATCH', { name: 'Changed', sortOrder: 3 }, 'W/"stale"')).status).toBe(412);
    const changed = await call(`/calendars/${calendar.id}`, 'PATCH', { name: 'Changed', sortOrder: 3 }, created.headers.get('etag') ?? '');
    expect(changed.status).toBe(200);
    expect(Calendar.parse(await changed.json()).sortOrder).toBe(3);
    expect((await call('/calendars', 'POST', { name: 'Bad', color: '#abcd', timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await call(`/calendars/${calendar.id}/restore`, 'POST')).status).toBe(409);
    principal = { ...alice, tenantId: otherTenant };
    for (const [suffix, method] of [['', 'GET'], ['', 'PATCH'], ['', 'DELETE'], ['/restore', 'POST']] as const)
      expect((await call(`/calendars/${calendar.id}${suffix}`, method, method === 'PATCH' ? { name: 'No' } : undefined)).status).toBe(404);
    principal = alice;
    const [connected] = await unsafeDb().select({ calendar: sourceCalendar }).from(sourceCalendar).innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId)).where(eq(calendarAccount.provider, 'ics'));
    if (!connected) throw new Error('No imported calendar');
    for (const [suffix, method] of [['', 'PATCH'], ['', 'DELETE'], ['/restore', 'POST']] as const) {
      const response = await call(`/calendars/${connected.calendar.id}${suffix}`, method, method === 'PATCH' ? { name: 'No' } : undefined);
      expect(response.status).toBe(409);
      expect(Problem.parse(await response.json()).type).toBe('https://supercal.dev/problems/calendar-not-hosted');
    }
    const virtual = await withTenant(tenantId, (tx) => feeds.createPublication(tx, alice, pub!.feedId, { kind: 'virtual', name: 'Lifecycle merge', sources: [{ calendarId: calendar.id }, { calendarId: connected.calendar.id }] }));
    expect((await call(`/calendars/${calendar.id}`, 'DELETE')).status).toBe(204);
    expect((await storedCalendar(calendar.id))?.state).toBe('gone');
    const [disabledVirtual] = await unsafeDb().select().from(publication).where(eq(publication.id, virtual.id));
    expect(disabledVirtual).toMatchObject({ enabled: false, epoch: virtual.epoch + 1 });
    expect(await unsafeDb().select().from(publicationSource).where(and(eq(publicationSource.publicationId, virtual.id), eq(publicationSource.sourceCalendarId, calendar.id)))).toHaveLength(0);
    expect((await unsafeDb().select().from(publication).where(eq(publication.id, pubId)))[0]?.enabled).toBe(false);
    expect((await withTenant(tenantId, (tx) => enabledPublications(tx, pub!.feedId))).some((p) => p.id === pubId)).toBe(false);
    const listed = z.object({ items: z.array(Calendar) }).parse(await (await call('/calendars')).json());
    expect(listed.items.some((item) => item.id === calendar.id)).toBe(true);
    expect((await call(`/calendars/${calendar.id}/restore`, 'POST')).status).toBe(200);
    expect((await storedCalendar(calendar.id))?.goneAt).toBeNull();
    expect((await unsafeDb().select().from(publication).where(eq(publication.id, pubId)))[0]?.enabled).toBe(false);
    await withTenant(tenantId, (tx) => feeds.updatePublication(tx, alice, pubId, { enabled: true }));
    expect((await withTenant(tenantId, (tx) => enabledPublications(tx, pub!.feedId))).some((p) => p.id === pubId)).toBe(true);
    expect((await call(`/calendars/${calendar.id}`, 'DELETE')).status).toBe(204);
    await unsafeDb().update(sourceCalendar).set({ goneAt: sql`now() - interval '29 days'` }).where(eq(sourceCalendar.id, calendar.id));
    await maintenance('purge-hosted-calendars');
    expect(await storedCalendar(calendar.id)).toBeDefined();
    await unsafeDb().update(sourceCalendar).set({ goneAt: sql`now() - interval '31 days'` }).where(eq(sourceCalendar.id, calendar.id));
    await maintenance('purge-hosted-calendars');
    expect(await storedCalendar(calendar.id)).toBeUndefined();
    for (const table of [sourceObject, resource, publicationSource]) expect(await unsafeDb().select().from(table).where(eq(table.sourceCalendarId, calendar.id))).toHaveLength(0);
    await registerMaintenance();
    expect((await unsafeDb().select().from(syncTarget).where(and(eq(syncTarget.kind, 'maintenance'), eq(syncTarget.targetId, 'purge-hosted-calendars'))))).toHaveLength(1);
    const actions = await unsafeDb().select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.targetId, calendar.id));
    expect(actions.map((row) => row.action)).toEqual(['calendar.create', 'calendar.update', 'calendar.delete', 'calendar.restore', 'calendar.delete']);
  });
});
