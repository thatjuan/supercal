/** A device login and an empty hosted calendar for protocol and real-client write tests. */
import { davLogin, member, organization, user, withTenant, type TenantId } from '@supercal/db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { createFeedService } from '../../src/feeds/service.ts';
import { createCalendar } from '../../src/hosted/calendars.ts';
import { testSecrets } from '../auth-fixture.ts';

export const DEVICE = { username: 'writer-dav-abcdefgh', password: 'device-password', userId: 'user_hosted_dav', tenantId: 'org_hosted_dav' as TenantId };
export async function seedHosted() {
  const now = new Date();
  const db = unsafeDb();
  await db.insert(organization).values({ id: DEVICE.tenantId, name: 'Hosted', slug: DEVICE.tenantId, createdAt: now });
  await db.insert(user).values({ id: DEVICE.userId, name: 'Writer', email: 'writer@example.test', updatedAt: now });
  await db.insert(member).values({ id: 'member_hosted_dav', organizationId: DEVICE.tenantId, userId: DEVICE.userId, role: 'member', createdAt: now });
  const [login] = await db.insert(davLogin).values({ tenantId: DEVICE.tenantId, userId: DEVICE.userId, name: 'Test device', username: DEVICE.username, passwordHash: await Bun.password.hash(DEVICE.password, { algorithm: 'argon2id' }) }).returning();
  if (!login) throw new Error('No device login');
  const calendar = await withTenant(DEVICE.tenantId, (tx) => createCalendar(tx, createFeedService(testSecrets), DEVICE.userId, { name: 'Hosted' }));
  return { login, calendar };
}

/** Two colleagues exercise shared device collections through real clients. */
export async function seedShared(calendar: Awaited<ReturnType<typeof seedHosted>>['calendar']) {
  const { calendarShare } = await import('@supercal/db');
  const { writeObject } = await import('../../src/hosted/objects.ts');
  const { eventIcs } = await import('./fixture.ts');
  const read = { userId: 'shared_dav_reader', username: 'shared-reader-abcdefgh', password: 'shared-reader-password', access: 'read' } as const;
  const write = { userId: 'shared_dav_writer', username: 'shared-writer-abcdefgh', password: 'shared-writer-password', access: 'write' } as const;
  for (const colleague of [read, write]) {
    await unsafeDb().insert(user).values({ id: colleague.userId, name: colleague.userId, email: `${colleague.userId}@example.test`, updatedAt: new Date() });
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: DEVICE.tenantId, userId: colleague.userId, role: 'member', createdAt: new Date() });
    await unsafeDb().insert(davLogin).values({ tenantId: DEVICE.tenantId, userId: colleague.userId, name: 'Shared client', username: colleague.username, passwordHash: await Bun.password.hash(colleague.password, { algorithm: 'argon2id' }) });
    await withTenant(DEVICE.tenantId, (tx) => tx.insert(calendarShare).values({ tenantId: DEVICE.tenantId, calendarId: calendar.id, granteeUserId: colleague.userId, access: colleague.access, createdBy: DEVICE.userId }));
  }
  await withTenant(DEVICE.tenantId, (tx) => writeObject(tx, calendar, { objectName: 'private.ics', payload: eventIcs('private-shared', ['DTSTART:20261109T090000Z', 'DURATION:PT1H', 'CLASS:PRIVATE', 'SUMMARY:Secret']) }));
  return { read, write };
}
