/**
 * Test-only: a seeded CalDAV world, shared by the integration tests and the real-client run.
 * Alice's feed (tenant A) publishes `work` (passthrough), `merged` (virtual: work + home),
 * `busy` (busy-only passthrough of home), `bulk` (5,000 objects) and a disabled `hidden`.
 * Bob's feed (tenant B) publishes `personal`. `work` holds a recurring series with an override,
 * an all-day event, a floating event and a meeting whose UID is also in `home`.
 *
 * Call `connectDb` first. Mutations go through `recordChanges` / `bumpEpoch`, like production.
 */
import { normalizeIcal, revisionOf, spanOf } from '@supercal/core';
import {
  bumpEpoch,
  calendarAccount,
  feed,
  member,
  newId,
  organization,
  publication,
  publicationSource,
  recordChanges,
  sourceCalendar,
  user,
  withTenant,
  type ResourceChange,
  type SourceCalendarId,
  type TenantId,
} from '@supercal/db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { eq } from 'drizzle-orm';
import { newUidSecret } from '../../src/feeds/credentials.ts';
import { testSecrets } from '../auth-fixture.ts';

export const ALICE = { username: 'alice-dav', password: 'alice-app-password' } as const;
export const BOB = { username: 'bob-dav', password: 'bob-app-password' } as const;
export const BULK_SIZE = 5000;

type CalendarName = 'work' | 'home' | 'bulk' | 'personal';
const OWNER: Record<CalendarName, 'alice' | 'bob'> = { work: 'alice', home: 'alice', bulk: 'alice', personal: 'bob' };
const tenantOf = (owner: 'alice' | 'bob') => `org_dav_${owner}` as TenantId;

/** A VCALENDAR with one VEVENT (plus `extra` components, e.g. overrides) for `uid`. */
export function eventIcs(uid: string, lines: string[], extra: string[][] = []): string {
  const vevent = (body: string[]) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...body, 'END:VEVENT'];
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...vevent(lines), ...extra.flatMap(vevent), 'END:VCALENDAR'].join('\r\n');
}

const simple = (summary: string, start = '20261110T090000Z') => [`SUMMARY:${summary}`, `DTSTART:${start}`, 'DURATION:PT1H'];

function upsert(sourceCalendarId: SourceCalendarId, uid: string, ics: string): ResourceChange {
  const { resource, completeness } = normalizeIcal([{ id: `${uid}.ics`, etag: '1', groupUid: uid, payload: ics }]);
  const span = spanOf(resource, 'UTC');
  return {
    op: 'upsert',
    sourceCalendarId,
    uid,
    resource,
    revision: revisionOf(resource),
    sequence: 0,
    lastModified: null,
    organizer: null,
    span: { start: new Date(span.start.epochMilliseconds), end: span.end === 'infinity' ? 'infinity' : new Date(span.end.epochMilliseconds) },
    completeness,
  };
}

async function calendarId(name: CalendarName): Promise<SourceCalendarId> {
  const [row] = await unsafeDb().select({ id: sourceCalendar.id }).from(sourceCalendar).where(eq(sourceCalendar.providerCalendarId, `/${name}/`));
  if (!row) throw new Error(`no calendar ${name}`);
  return row.id;
}

/** Upserts `uid` in calendar `name` with a one-hour event titled `summary`. */
export async function putEvent(name: CalendarName, uid: string, summary: string, start?: string) {
  const id = await calendarId(name);
  await withTenant(tenantOf(OWNER[name]), (tx) => recordChanges(tx, [upsert(id, uid, eventIcs(uid, simple(summary, start)))]));
}

/** Tombstones `uid` in calendar `name`. */
export async function deleteEvent(name: CalendarName, uid: string) {
  const id = await calendarId(name);
  await withTenant(tenantOf(OWNER[name]), (tx) => recordChanges(tx, [{ op: 'delete', sourceCalendarId: id, uid }]));
}

/** Bumps the epoch of Alice's publication `slug`, invalidating its sync tokens. */
export async function bumpPublicationEpoch(slug: string) {
  await withTenant(tenantOf('alice'), async (tx) => {
    const [row] = await tx.select({ id: publication.id }).from(publication).where(eq(publication.slug, slug));
    if (!row) throw new Error(`no publication ${slug}`);
    await bumpEpoch(tx, row.id);
  });
}

/** Alice's feed row id, for credential rotation. */
export async function aliceFeedId() {
  const [row] = await unsafeDb().select({ id: feed.id }).from(feed).where(eq(feed.caldavUsername, ALICE.username));
  if (!row) throw new Error('no alice feed');
  return row.id;
}

/** Seeds an empty, migrated database. */
export async function seed() {
  const db = unsafeDb();
  const now = new Date();
  const ids = { alice: 'user_dav_alice', bob: 'user_dav_bob' } as const;
  const calendars = {} as Record<CalendarName, SourceCalendarId>;

  for (const owner of ['alice', 'bob'] as const) {
    const tenantId = tenantOf(owner);
    await db.insert(organization).values({ id: tenantId, name: owner, slug: tenantId, createdAt: now });
    await db.insert(user).values({ id: ids[owner], name: owner, email: `${owner}@example.com`, updatedAt: now });
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: ids[owner], role: 'owner', createdAt: now });
    const [account] = await db
      .insert(calendarAccount)
      .values({ tenantId, ownerUserId: ids[owner], provider: 'caldav', displayName: owner, email: `${owner}@example.com` })
      .returning();
    if (!account) throw new Error('account insert failed');
    for (const name of (Object.keys(OWNER) as CalendarName[]).filter((n) => OWNER[n] === owner)) {
      const [row] = await db
        .insert(sourceCalendar)
        .values({ tenantId, accountId: account.id, providerCalendarId: `/${name}/`, name, timezone: 'Europe/Berlin' })
        .returning();
      if (!row) throw new Error('calendar insert failed');
      calendars[name] = row.id;
    }
  }

  async function addFeed(owner: 'alice' | 'bob', creds: { username: string; password: string }) {
    const tenantId = tenantOf(owner);
    const id = newId('feed');
    await db.insert(feed).values({
      id,
      tenantId,
      ownerUserId: ids[owner],
      name: `${owner}'s calendars`,
      isDefault: true,
      caldavUsername: creds.username,
      caldavPasswordHash: await Bun.password.hash(creds.password, { algorithm: 'argon2id' }),
      uidSecret: await newUidSecret(testSecrets, { tenantId, id }),
    });
    return { id, tenantId };
  }

  async function addPublication(
    f: { id: string; tenantId: TenantId },
    slug: string,
    kind: 'passthrough' | 'virtual',
    sources: CalendarName[],
    extra: { privacy?: 'busy-only'; enabled?: boolean; color?: string; sortOrder: number },
  ) {
    const [pub] = await db
      .insert(publication)
      .values({ tenantId: f.tenantId, feedId: f.id as never, kind, slug, name: slug[0]?.toUpperCase() + slug.slice(1), ...extra })
      .returning();
    if (!pub) throw new Error('publication insert failed');
    await db.insert(publicationSource).values(sources.map((s, priority) => ({ tenantId: f.tenantId, publicationId: pub.id, sourceCalendarId: calendars[s], priority })));
  }

  const alice = await addFeed('alice', ALICE);
  await addPublication(alice, 'work', 'passthrough', ['work'], { color: '#336699', sortOrder: 0 });
  await addPublication(alice, 'merged', 'virtual', ['work', 'home'], { sortOrder: 1 });
  await addPublication(alice, 'busy', 'passthrough', ['home'], { privacy: 'busy-only', sortOrder: 2 });
  await addPublication(alice, 'bulk', 'passthrough', ['bulk'], { sortOrder: 3 });
  await addPublication(alice, 'hidden', 'passthrough', ['home'], { enabled: false, sortOrder: 4 });
  const bob = await addFeed('bob', BOB);
  await addPublication(bob, 'personal', 'passthrough', ['personal'], { sortOrder: 0 });

  const series = eventIcs(
    'series@example.com',
    ['SUMMARY:Weekly sync', 'DTSTART:20261102T100000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;COUNT=8'],
    [['RECURRENCE-ID:20261109T100000Z', 'SUMMARY:Weekly sync (moved)', 'DTSTART:20261109T140000Z', 'DURATION:PT30M']],
  );
  await withTenant(alice.tenantId, (tx) =>
    recordChanges(tx, [
      upsert(calendars.work, 'series@example.com', series),
      upsert(calendars.work, 'allday@example.com', eventIcs('allday@example.com', ['SUMMARY:Holidays', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261227'])),
      upsert(calendars.work, 'floating@example.com', eventIcs('floating@example.com', ['SUMMARY:Floating wake-up', 'DTSTART:20261115T070000', 'DURATION:PT15M'])),
      upsert(calendars.work, 'meeting@example.com', eventIcs('meeting@example.com', simple('Shared meeting', '20261112T120000Z'))),
      upsert(calendars.home, 'meeting@example.com', eventIcs('meeting@example.com', simple('Shared meeting', '20261112T120000Z'))),
      upsert(calendars.home, 'dentist@example.com', eventIcs('dentist@example.com', [...simple('Dentist', '20261118T080000Z'), 'LOCATION:Main St'])),
    ]),
  );
  const bulk = Array.from({ length: BULK_SIZE }, (_, i) => {
    const uid = `bulk-${i}@example.com`;
    const day = String(1 + (i % 28)).padStart(2, '0');
    return upsert(calendars.bulk, uid, eventIcs(uid, simple(`Bulk ${i}`, `202612${day}T${String(i % 24).padStart(2, '0')}0000Z`)));
  });
  await withTenant(alice.tenantId, (tx) => recordChanges(tx, bulk));
  await withTenant(bob.tenantId, (tx) => recordChanges(tx, [upsert(calendars.personal, 'bob-1@example.com', eventIcs('bob-1@example.com', simple('Bob thing')))]));
}
