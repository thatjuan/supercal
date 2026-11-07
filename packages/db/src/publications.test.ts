import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { newId, type TenantId } from './ids.ts';
import { migrate } from './migrate.ts';
import { bumpConfigVersion, bumpEpoch, publicationChangeKind, type PublicationChangeKind, type PublicationConfig } from './publications.ts';
import { feed, organization, publication, user } from './schema/index.ts';
import { testDatabaseUrl } from './test-db.ts';
import { withTenant } from './tx.ts';
import { closeDb, connectDb, unsafeDb } from './unsafe-db.ts';

const calA = newId('cal');
const calB = newId('cal');

const base: PublicationConfig = {
  feedId: newId('feed'),
  kind: 'virtual',
  slug: 'work',
  name: 'Work',
  color: '#336699',
  privacy: 'full',
  filters: { hideDeclined: false, hideCancelled: false, hideAllDay: false },
  keepAlarms: false,
  enabled: true,
  sortOrder: 0,
  sources: [
    { sourceCalendarId: calA, priority: 0 },
    { sourceCalendarId: calB, priority: 1 },
  ],
};

const cases: [string, Partial<PublicationConfig>, PublicationChangeKind][] = [
  ['name', { name: 'Job' }, 'config'],
  ['colour', { color: '#ff0000' }, 'config'],
  ['sort order', { sortOrder: 3 }, 'config'],
  ['privacy', { privacy: 'busy-only' }, 'epoch'],
  ['sources', { sources: [{ sourceCalendarId: calA, priority: 0 }] }, 'epoch'],
  ['source priority', { sources: [{ sourceCalendarId: calA, priority: 1 }, { sourceCalendarId: calB, priority: 0 }] }, 'epoch'],
  ['filters', { filters: { ...base.filters, hideDeclined: true } }, 'epoch'],
  ['name and privacy', { name: 'Job', privacy: 'title-only' }, 'epoch'],
  ['sources reordered', { sources: [...base.sources].reverse() }, 'none'],
  ['nothing', {}, 'none'],
];

test.each(cases)('publicationChangeKind: %s', (_, change, expected) => {
  expect(publicationChangeKind(base, { ...base, ...change })).toBe(expected);
});

describe.skipIf(!testDatabaseUrl)('publication versions', () => {
  const tenantId = `org_${crypto.randomUUID()}` as TenantId;
  const userId = `user_${crypto.randomUUID()}`;
  const publicationId = newId('pub');

  beforeAll(async () => {
    const url = testDatabaseUrl ?? '';
    await migrate(url);
    connectDb(url);
    const db = unsafeDb();
    const now = new Date();
    await db.insert(user).values({ id: userId, name: 'Test', email: `${userId}@example.com`, updatedAt: now });
    await db.insert(organization).values({ id: tenantId, name: tenantId, slug: tenantId, createdAt: now });
    const [created] = await db
      .insert(feed)
      .values({ tenantId, ownerUserId: userId, name: 'Feed', caldavUsername: `u-${crypto.randomUUID()}`, uidSecret: 'sc1.x' })
      .returning({ id: feed.id });
    await db.insert(publication).values({ id: publicationId, tenantId, feedId: created?.id ?? newId('feed'), kind: 'passthrough', slug: 's', name: 'N' });
  });

  afterAll(async () => {
    await unsafeDb().delete(organization).where(eq(organization.id, tenantId));
    await unsafeDb().delete(user).where(eq(user.id, userId));
    await closeDb();
  });

  test('bumpEpoch and bumpConfigVersion each advance only their own counter', async () => {
    const versions = await withTenant(tenantId, async (tx) => [await bumpEpoch(tx, publicationId), await bumpEpoch(tx, publicationId), await bumpConfigVersion(tx, publicationId)]);
    expect(versions).toEqual([1, 2, 1]);
    const [row] = await unsafeDb().select({ epoch: publication.epoch, configVersion: publication.configVersion }).from(publication).where(eq(publication.id, publicationId));
    expect(row).toEqual({ epoch: 2, configVersion: 1 });
  });
});
