/**
 * Feeds and publications over a scratch database: the publication lifecycle and its version
 * bumps, the sync-engine hooks, credential rotation, tenant and role isolation, and the
 * occurrences preview. Requests go through the real API with an injected principal.
 */
import { normalizeIcal, spanOf } from '@supercal/core';
import {
  calendarAccount,
  closeDb,
  connectDb,
  feed,
  member,
  migrate,
  organization,
  publication,
  recordChanges,
  sink,
  sourceCalendar,
  user,
  withTenant,
  type CalendarAccount,
  type SourceCalendar,
  type TenantId,
} from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import type { ApiEnv, Principal, TenantRole } from '../src/auth/principal.ts';
import { icsTokenHash } from '../src/feeds/credentials.ts';
import { createFeedService } from '../src/feeds/service.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const tenantA = `org_${crypto.randomUUID()}` as TenantId;
const tenantB = `org_${crypto.randomUUID()}` as TenantId;
const people = { alice: tenantA, bob: tenantA, admin: tenantA, carol: tenantB } as const;
type Person = keyof typeof people;
const roles: Record<Person, TenantRole> = { alice: 'member', bob: 'member', admin: 'admin', carol: 'owner' };
const userIds = Object.fromEntries(Object.keys(people).map((name) => [name, `user_${name}_${crypto.randomUUID().slice(0, 8)}`])) as Record<Person, string>;

let principal: Principal;
const as = (person: Person) =>
  (principal = { kind: 'user', userId: userIds[person], tenantId: people[person], role: roles[person], via: 'session', isOperator: false });
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const feeds = createFeedService(testSecrets);
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let fixture: ReturnType<typeof testAuth> | undefined;
let app: ReturnType<typeof createApi>;

type Json = Record<string, unknown> & { id: string };

async function call(path: string, { method = 'GET', body, ifMatch }: { method?: string; body?: unknown; ifMatch?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(ifMatch && { 'if-match': ifMatch }) };
  const res = await app.request(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag') ?? '', body: (text ? JSON.parse(text) : null) as Json & { items: Json[] } };
}

const versions = async (id: string) => {
  const [row] = await unsafeDb().select({ epoch: publication.epoch, configVersion: publication.configVersion }).from(publication).where(eq(publication.id, id as never));
  return row;
};

let account: CalendarAccount;
let quietAccount: CalendarAccount;
const calendars: Record<'work' | 'home' | 'gym' | 'trips' | 'mirror', SourceCalendar> = {} as never;

/** Alice's default feed id, created through the API on first access. */
async function aliceDefaultFeed() {
  as('alice');
  const { body } = await call('/api/v1/feeds');
  const found = body.items.find((f) => f.isDefault);
  if (!found) throw new Error('no default feed');
  return found.id;
}

describe.skipIf(!testDatabaseUrl)('feeds and publications', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('feeds');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('invite', scratch.url);
    app = createApi({ auth: fixture.auth, secrets: testSecrets }, injectPrincipal);

    const db = unsafeDb();
    const now = new Date();
    for (const id of [tenantA, tenantB]) await db.insert(organization).values({ id, name: id, slug: id, createdAt: now });
    for (const person of Object.keys(people) as Person[]) {
      await db.insert(user).values({ id: userIds[person], name: person, email: `${person}.Smith@example.com`, updatedAt: now });
      await db.insert(member).values({ id: crypto.randomUUID(), organizationId: people[person], userId: userIds[person], role: roles[person], createdAt: now });
    }
    const accountOf = async (autoPublish: boolean) => {
      const [row] = await db
        .insert(calendarAccount)
        .values({ tenantId: tenantA, ownerUserId: userIds.alice, provider: 'caldav', displayName: 'Alice', email: 'alice@example.com', autoPublish })
        .returning();
      if (!row) throw new Error('account insert failed');
      return row;
    };
    account = await accountOf(true);
    quietAccount = await accountOf(false);
    for (const name of ['work', 'home', 'gym', 'trips', 'mirror'] as const) {
      const [row] = await db
        .insert(sourceCalendar)
        .values({ tenantId: tenantA, accountId: name === 'trips' ? quietAccount.id : account.id, providerCalendarId: `/cal/${name}/`, name: `Alice ${name}`, color: '#336699FF', timezone: 'Europe/Berlin' })
        .returning();
      if (!row) throw new Error('calendar insert failed');
      calendars[name] = row;
    }
  });

  afterAll(async () => {
    await fixture?.close();
    await closeDb();
    await scratch?.drop();
  });

  test('virtual publication lifecycle bumps epoch for output changes and config_version for cosmetic ones', async () => {
    const feedId = await aliceDefaultFeed();
    const created = await call(`/api/v1/feeds/${feedId}/publications`, {
      method: 'POST',
      body: { kind: 'virtual', name: 'Everything', sources: [{ calendarId: calendars.work.id }, { calendarId: calendars.home.id }] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'virtual', slug: 'everything', sources: [{ calendarId: calendars.work.id, priority: 0 }, { calendarId: calendars.home.id, priority: 1 }] });
    const id = created.body.id;
    expect(await versions(id)).toEqual({ epoch: 1, configVersion: 0 });

    const renamed = await call(`/api/v1/publications/${id}`, { method: 'PATCH', body: { name: 'All of it' }, ifMatch: created.etag });
    expect(renamed.status).toBe(200);
    expect(await versions(id)).toEqual({ epoch: 1, configVersion: 1 });
    expect((await call(`/api/v1/publications/${id}`, { method: 'PATCH', body: { name: 'Stale' }, ifMatch: created.etag })).status).toBe(412);

    expect((await call(`/api/v1/publications/${id}`, { method: 'PATCH', body: { privacy: 'busy-only' } })).status).toBe(200);
    expect(await versions(id)).toEqual({ epoch: 2, configVersion: 1 });

    const shrunk = await call(`/api/v1/publications/${id}`, { method: 'PATCH', body: { sources: [{ calendarId: calendars.work.id }] } });
    expect(shrunk.status).toBe(400);
    expect(await versions(id)).toEqual({ epoch: 2, configVersion: 1 });

    expect((await call(`/api/v1/publications/${id}`, { method: 'PATCH', body: { enabled: false } })).body).toMatchObject({ enabled: false });
    expect(await versions(id)).toEqual({ epoch: 3, configVersion: 1 });
  });

  test('sources are validated: duplicates in a feed conflict, sink targets and foreign calendars are rejected', async () => {
    const feedId = await aliceDefaultFeed();
    const passthrough = (calendarId: string) => call(`/api/v1/feeds/${feedId}/publications`, { method: 'POST', body: { kind: 'passthrough', sourceCalendarId: calendarId } });
    const first = await passthrough(calendars.gym.id);
    expect(first.body).toMatchObject({ kind: 'passthrough', name: 'Alice gym', color: '#336699', enabled: true });
    expect((await passthrough(calendars.gym.id)).status).toBe(409);

    const [created] = await unsafeDb().insert(publication).values({ tenantId: tenantA, feedId: feedId as never, kind: 'virtual', slug: 'sinkpub', name: 'S' }).returning();
    await unsafeDb().insert(sink).values({ tenantId: tenantA, publicationId: created?.id as never, accountId: account.id, provider: 'caldav', providerCalendarId: calendars.mirror.providerCalendarId });
    const mirrored = await passthrough(calendars.mirror.id);
    expect(mirrored.status).toBe(400);
    expect(mirrored.body.detail).toContain('sink');

    as('bob');
    const bobFeed = (await call('/api/v1/feeds')).body.items[0]?.id;
    const foreign = await call(`/api/v1/feeds/${bobFeed}/publications`, { method: 'POST', body: { kind: 'passthrough', sourceCalendarId: calendars.home.id } });
    expect(foreign.status).toBe(400);
  });

  test('ensurePassthroughPublication is idempotent and respects auto_publish', async () => {
    const [published, again, quiet] = await withTenant(tenantA, async (tx) => [
      await feeds.ensurePassthroughPublication(tx, calendars.home, account),
      await feeds.ensurePassthroughPublication(tx, calendars.home, account),
      await feeds.ensurePassthroughPublication(tx, calendars.trips, quietAccount),
    ]);
    expect(again?.id).toBe(published?.id ?? '');
    expect(published).toMatchObject({ kind: 'passthrough', name: 'Alice home', color: '#336699', enabled: true, privacy: 'full', keepAlarms: false, epoch: 1 });
    expect(quiet).toMatchObject({ enabled: false, sources: [{ calendarId: calendars.trips.id }] });
    expect(quiet?.sortOrder).toBeGreaterThan(published?.sortOrder ?? Infinity);
    const defaults = await unsafeDb().select().from(feed).where(eq(feed.ownerUserId, userIds.alice));
    expect(defaults.filter((f) => f.isDefault)).toHaveLength(1);
  });

  test('onCalendarGone disables a virtual publication left with one source', async () => {
    const feedId = await aliceDefaultFeed();
    const { body } = await call(`/api/v1/feeds/${feedId}/publications`, {
      method: 'POST',
      body: { kind: 'virtual', name: 'Pair', sources: [{ calendarId: calendars.gym.id }, { calendarId: calendars.trips.id }] },
    });
    await withTenant(tenantA, (tx) => feeds.onCalendarGone(tx, calendars.trips.id));
    const after = await call(`/api/v1/publications/${body.id}`);
    expect(after.body).toMatchObject({ enabled: false, status: 'disabled-invalid', statusDetail: 'needs at least two calendars', sources: [{ calendarId: calendars.gym.id }] });
    expect(await versions(body.id)).toMatchObject({ epoch: 2 });
    const passthrough = (await call(`/api/v1/feeds/${feedId}/publications`)).body.items.find((p) => p.sourceCalendarId === calendars.trips.id);
    expect(passthrough).toMatchObject({ enabled: false, status: 'disabled-invalid' });
    expect((await call(`/api/v1/publications/${body.id}`, { method: 'PATCH', body: { enabled: true } })).status).toBe(400);
  });

  test('rotating credentials replaces the stored hashes, so old secrets stop working', async () => {
    as('alice');
    const created = await call('/api/v1/feeds', { method: 'POST', body: { name: 'For my assistant' } });
    expect(created.status).toBe(201);
    const { caldav, ics } = created.body.credentials as { caldav: { username: string; password: string }; ics: { token: string; urls: { combined: string } } };
    expect(caldav.username).toMatch(/^alice-smith-[a-z0-9]{6}$/);
    expect(caldav.password).toMatch(/^[a-z2-7]{39}$/);
    expect(ics.urls.combined).toEndWith(`/ics/${ics.token}/all.ics`);
    const id = (created.body.feed as Json).id;
    const stored = async () => (await unsafeDb().select().from(feed).where(eq(feed.id, id as never)))[0];

    const rotated = await call(`/api/v1/feeds/${id}/credentials/caldav/rotate`, { method: 'POST' });
    expect(rotated.body).toMatchObject({ username: caldav.username });
    const { caldavPasswordHash } = (await stored()) ?? {};
    expect(await Bun.password.verify(rotated.body.password as string, caldavPasswordHash ?? '')).toBe(true);
    expect(await Bun.password.verify(caldav.password, caldavPasswordHash ?? '')).toBe(false);

    const newIcs = await call(`/api/v1/feeds/${id}/credentials/ics/rotate`, { method: 'POST' });
    expect((await stored())?.icsTokenHash).toBe(icsTokenHash(newIcs.body.token as string));
    expect((await unsafeDb().select().from(feed).where(eq(feed.icsTokenHash, icsTokenHash(ics.token))))).toEqual([]);

    // Reads never expose secrets.
    expect(Object.keys((await call(`/api/v1/feeds/${id}`)).body).sort()).toEqual(['caldavUsername', 'id', 'isDefault', 'name', 'ownerUserId']);
    expect((await call(`/api/v1/feeds/${await aliceDefaultFeed()}`, { method: 'DELETE' })).status).toBe(409);
    expect((await call(`/api/v1/feeds/${id}`, { method: 'DELETE' })).status).toBe(204);
  });

  test('another tenant sees 404; another member is refused; an admin may manage the feed', async () => {
    const feedId = await aliceDefaultFeed();
    as('carol');
    expect((await call(`/api/v1/feeds/${feedId}`)).status).toBe(404);
    as('bob');
    expect((await call(`/api/v1/feeds/${feedId}`)).status).toBe(403);
    expect((await call(`/api/v1/feeds?ownerUserId=${userIds.alice}`)).status).toBe(403);
    as('admin');
    expect((await call(`/api/v1/feeds/${feedId}`)).status).toBe(200);
    expect((await call(`/api/v1/feeds?ownerUserId=${userIds.alice}`)).body.items.map((f) => f.id)).toContain(feedId);
    expect((await call(`/api/v1/feeds?ownerUserId=${userIds.carol}`)).status).toBe(404);
  });

  test('the occurrences preview of a busy-only publication shows "Busy" and no location', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:standup@example.com',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;TZID=Europe/Berlin:20260105T090000',
      'DURATION:PT15M',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Standup',
      'LOCATION:Room 4',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const { resource, completeness } = normalizeIcal([{ id: 'standup.ics', etag: '1', groupUid: 'standup@example.com', payload: ics }]);
    const span = spanOf(resource, 'Europe/Berlin');
    await withTenant(tenantA, (tx) =>
      recordChanges(tx, [
        {
          op: 'upsert',
          sourceCalendarId: calendars.work.id,
          uid: resource.uid,
          resource,
          revision: 'r1',
          sequence: 0,
          lastModified: null,
          organizer: null,
          span: { start: new Date(span.start.epochMilliseconds), end: span.end === 'infinity' ? 'infinity' : new Date(span.end.epochMilliseconds) },
          completeness,
        },
      ]),
    );

    const feedId = await aliceDefaultFeed();
    const pub = await withTenant(tenantA, (tx) => feeds.ensurePassthroughPublication(tx, calendars.work, account));
    const window = 'from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z';
    const full = await call(`/api/v1/feeds/${feedId}/occurrences?${window}&publicationId=${pub.id}`);
    expect(full.body.items).toHaveLength(3);
    expect(full.body.items[0]).toMatchObject({ summary: 'Standup', location: 'Room 4', start: '2026-01-05T08:00:00Z', end: '2026-01-05T08:15:00Z', color: '#336699' });

    await call(`/api/v1/publications/${pub.id}`, { method: 'PATCH', body: { privacy: 'busy-only' } });
    const busy = await call(`/api/v1/feeds/${feedId}/occurrences?${window}&publicationId=${pub.id}`);
    expect(busy.body.truncated).toBe(false);
    expect(busy.body.items.map((o) => [o.summary, 'location' in o])).toEqual([
      ['Busy', false],
      ['Busy', false],
      ['Busy', false],
    ]);
    expect(busy.body.items[0]?.outputUid).not.toBe('standup@example.com');
    expect((await call(`/api/v1/feeds/${feedId}/occurrences?from=2026-01-01T00:00:00Z&to=2026-03-15T00:00:00Z`)).status).toBe(400);
  });
});
