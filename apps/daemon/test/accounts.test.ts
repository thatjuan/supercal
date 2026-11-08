/**
 * Accounts and calendars through the API over a scratch database, with the fake provider behind
 * the `ics` variant: connecting (and rejected credentials), visibility by role, PATCH with
 * If-Match, replacing credentials, the manual-sync rate limit, and disconnecting.
 */
import { auditLog, calendarAccount, closeDb, connectDb, member, migrate, organization, publication, sourceCalendar, syncTarget, user, type AccountId, type PublicationId, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { AuthFailedError, caldavAdapter, icloudAdapter } from '@supercal/providers';
import { DavFixture } from '@supercal/providers/test/dav-fixture';
import { createFakeAdapter, fakeEvent } from '@supercal/providers/test/fake';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal, TenantRole } from '../src/auth/principal.ts';
import { idleBus } from '../src/bus.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const people = { alice: 'member', bob: 'member', admin: 'admin' } as const satisfies Record<string, TenantRole>;
type Person = keyof typeof people;
const userIds = Object.fromEntries(Object.keys(people).map((name) => [name, `user_${name}_${crypto.randomUUID().slice(0, 8)}`])) as Record<Person, string>;

let principal: Principal;
const as = (person: Person) => (principal = { kind: 'user', userId: userIds[person], tenantId, role: people[person], via: 'session', isOperator: false });
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const fake = createFakeAdapter();
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let app: ReturnType<typeof createApi>;
/** The API with the real CalDAV and iCloud adapters over a scripted CalDAV server. */
const dav = new DavFixture().collection('/u/cals/work/', { name: 'Work' });
let davApp: ReturnType<typeof createApi>;

type Json = Record<string, unknown> & { id: string };
async function call(path: string, { method = 'GET', body, ifMatch, via = app }: { method?: string; body?: unknown; ifMatch?: string; via?: typeof app } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(ifMatch && { 'if-match': ifMatch }) };
  const res = await via.request(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag') ?? '', body: (text ? JSON.parse(text) : null) as Json & { items: Json[]; account: Json; calendars: Json[] } };
}

const ICS_URL = 'https://calendars.example.test/private/9f8e7d.ics';
const connect = () => call('/api/v1/accounts', { method: 'POST', body: { provider: 'ics', url: ICS_URL } });

describe.skipIf(!testDatabaseUrl)('accounts and calendars API', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('accounts');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus, adapters: { ics: fake.adapter } }, injectPrincipal);
    davApp = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus, fetch: dav.asGuardedFetch(), adapters: { caldav: caldavAdapter, icloud: icloudAdapter } }, injectPrincipal);
    const db = unsafeDb();
    const now = new Date();
    await db.insert(organization).values({ id: tenantId, name: 'T', slug: tenantId, createdAt: now });
    for (const person of Object.keys(people) as Person[]) {
      await db.insert(user).values({ id: userIds[person], name: person, email: `${person}@example.com`, updatedAt: now });
      await db.insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: userIds[person], role: people[person], createdAt: now });
    }
    fake.calendar('work', { name: 'Work', color: '#336699' }).put('a', fakeEvent('a@test'));
    fake.calendar('home', { name: 'Home' });
  });

  afterAll(async () => {
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('connecting lists the calendars first, then stores the account, its published calendars and targets', async () => {
    as('alice');
    const created = await connect();
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({ provider: 'ics', displayName: 'calendars.example.test', serverUrl: 'calendars.example.test', status: 'active', ownerUserId: userIds.alice });
    expect(created.body.calendars.map((c) => c.name).sort()).toEqual(['Home', 'Work']);
    for (const calendar of created.body.calendars) {
      expect(calendar.publicationIds).toHaveLength(1);
      expect(calendar.freshness).toEqual({ lastSuccessAt: null, pushActive: false, expectedLatency: null, stale: false });
    }

    const [stored] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, created.body.account.id as AccountId));
    expect(stored?.credentials).not.toContain('calendars.example.test');
    const targets = await unsafeDb()
      .select({ kind: syncTarget.kind })
      .from(syncTarget)
      .where(inArray(syncTarget.targetId, [created.body.account.id, ...created.body.calendars.map((c) => c.id)]));
    expect(targets.map((t) => t.kind).sort()).toEqual(['discover', 'events', 'events']);

    const listed = await call(`/api/v1/calendars?accountId=${created.body.account.id}`);
    expect(listed.body.items.map((c) => c.id).sort()).toEqual(created.body.calendars.map((c) => c.id).sort());
  });

  test('rejected credentials are a 422 invalid-credentials, and nothing is stored', async () => {
    as('bob');
    fake.fail({ at: 'list', error: new AuthFailedError('401 from the server') });
    const rejected = await connect();
    expect(rejected.status).toBe(422);
    expect(rejected.body.type).toBe('https://supercal.dev/problems/invalid-credentials');
    expect((await call('/api/v1/accounts')).body.items).toEqual([]);
  });

  test('members see their own accounts and calendars, admins every one in the tenant', async () => {
    as('alice');
    const [mine] = (await call('/api/v1/accounts')).body.items;
    if (!mine) throw new Error('alice has no account');
    as('bob');
    expect((await call('/api/v1/accounts')).body.items).toEqual([]);
    expect((await call('/api/v1/calendars')).body.items).toEqual([]);
    expect((await call(`/api/v1/accounts/${mine.id}`)).status).toBe(403);
    as('admin');
    expect((await call('/api/v1/accounts')).body.items.map((a) => a.id)).toEqual([mine.id]);
    expect((await call('/api/v1/calendars')).body.items).toHaveLength(2);
  });

  test('PATCH renames with If-Match and rejects a stale ETag', async () => {
    as('alice');
    const [mine] = (await call('/api/v1/accounts')).body.items;
    const current = await call(`/api/v1/accounts/${mine?.id}`);
    const renamed = await call(`/api/v1/accounts/${mine?.id}`, { method: 'PATCH', body: { displayName: 'Team ICS', autoPublish: false }, ifMatch: current.etag });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ displayName: 'Team ICS', autoPublish: false });
    expect((await call(`/api/v1/accounts/${mine?.id}`, { method: 'PATCH', body: { displayName: 'Stale' }, ifMatch: current.etag })).status).toBe(412);
  });

  test('PUT credentials proves the new ones, reactivates the account and audits without secrets', async () => {
    as('alice');
    const [mine] = (await call('/api/v1/accounts')).body.items;
    const id = mine?.id as AccountId;
    await unsafeDb().update(calendarAccount).set({ status: 'reauth_required', statusDetail: 'expired' }).where(eq(calendarAccount.id, id));
    const before = (await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, id)))[0]?.credentials;

    fake.fail({ at: 'list', error: new AuthFailedError('401 from the server') });
    const rejected = await call(`/api/v1/accounts/${id}/credentials`, { method: 'PUT', body: { provider: 'ics', url: 'https://rotated.example.test/new.ics' } });
    expect(rejected.body.type).toBe('https://supercal.dev/problems/invalid-credentials');
    expect((await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, id)))[0]?.credentials).toBe(before);

    const mismatch = await call(`/api/v1/accounts/${id}/credentials`, { method: 'PUT', body: { provider: 'icloud', appleId: 'a@icloud.com', appSpecificPassword: 'x' } });
    expect(mismatch.body.type).toBe('https://supercal.dev/problems/provider-mismatch');

    as('bob');
    expect((await call(`/api/v1/accounts/${id}/credentials`, { method: 'PUT', body: { provider: 'ics', url: 'https://x.test/a.ics' } })).status).toBe(403);

    as('alice');
    const replaced = await call(`/api/v1/accounts/${id}/credentials`, { method: 'PUT', body: { provider: 'ics', url: 'webcal://rotated.example.test/new.ics' } });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ status: 'active', statusDetail: null, serverUrl: 'rotated.example.test' });
    const [entry] = await unsafeDb().select().from(auditLog).where(eq(auditLog.action, 'account.credentials.update'));
    expect(entry?.data).toEqual({ provider: 'ics' });
  });

  test('a manual sync makes every target due now, at most once per 30 seconds', async () => {
    as('alice');
    const [mine] = (await call('/api/v1/accounts')).body.items;
    await unsafeDb().update(syncTarget).set({ nextRunAt: sql`clock_timestamp() + interval '1 hour'` });
    expect((await call(`/api/v1/accounts/${mine?.id}/sync`, { method: 'POST' })).status).toBe(202);
    const due = await unsafeDb().select({ due: sql<boolean>`${syncTarget.nextRunAt} <= clock_timestamp()` }).from(syncTarget).where(sql`${syncTarget.kind} <> 'maintenance'`);
    expect(due.every((t) => t.due)).toBe(true);
    expect((await call(`/api/v1/accounts/${mine?.id}/sync`, { method: 'POST' })).status).toBe(429);
  });

  test('disconnecting deletes the calendars and targets, and disables their publications', async () => {
    as('alice');
    const [mine] = (await call('/api/v1/accounts')).body.items;
    const calendars = (await call(`/api/v1/calendars?accountId=${mine?.id}`)).body.items;
    const publicationIds = calendars.flatMap((c) => c.publicationIds as PublicationId[]);
    expect((await call(`/api/v1/accounts/${mine?.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/v1/accounts/${mine?.id}`)).status).toBe(404);
    expect(await unsafeDb().select().from(sourceCalendar)).toEqual([]);
    expect(await unsafeDb().select().from(syncTarget).where(sql`${syncTarget.kind} <> 'maintenance'`)).toEqual([]);
    const pubs = await unsafeDb().select({ enabled: publication.enabled, epoch: publication.epoch }).from(publication).where(inArray(publication.id, publicationIds));
    expect(pubs).toEqual([
      { enabled: false, epoch: 2 },
      { enabled: false, epoch: 2 },
    ]);
  });

  test('a CalDAV server is discovered from its URL; the password is stored encrypted only', async () => {
    as('alice');
    const created = await call('/api/v1/accounts', { method: 'POST', via: davApp, body: { provider: 'caldav', serverUrl: 'https://dav.test/', username: 'alice', password: 'hunter2' } });
    expect(created.status).toBe(201);
    expect(created.body.account).toMatchObject({ provider: 'caldav', displayName: 'alice on dav.test', serverUrl: 'https://dav.test/' });
    expect(created.body.calendars.map((c) => c.name)).toEqual(['Work']);
    const [stored] = await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.id, created.body.account.id as AccountId));
    expect(stored?.credentials).not.toContain('hunter2');
  });

  test('a Digest-only CalDAV server is a 422 unsupported-auth', async () => {
    as('bob');
    dav.quirks.status = 401;
    dav.quirks.challenge = 'Digest realm="dav", nonce="n"';
    const rejected = await call('/api/v1/accounts', { method: 'POST', via: davApp, body: { provider: 'caldav', serverUrl: 'https://dav.test/', username: 'bob', password: 'x' } });
    expect(rejected.status).toBe(422);
    expect(rejected.body.type).toBe('https://supercal.dev/problems/unsupported-auth');
  });

  test('rejected iCloud credentials are a 422 pointing at app-specific passwords', async () => {
    as('bob');
    dav.quirks.status = 401;
    dav.quirks.challenge = 'Basic realm="iCloud"';
    const rejected = await call('/api/v1/accounts', { method: 'POST', via: davApp, body: { provider: 'icloud', appleId: 'bob@icloud.com', appSpecificPassword: 'wrong' } });
    expect(rejected.status).toBe(422);
    expect(rejected.body.type).toBe('https://supercal.dev/problems/invalid-credentials');
    expect(rejected.body.detail).toContain('https://support.apple.com/en-us/102654');
  });
});
