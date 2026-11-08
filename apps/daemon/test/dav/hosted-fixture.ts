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
