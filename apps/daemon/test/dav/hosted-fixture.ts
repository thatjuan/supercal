/** Device logins with hosted and imported calendars for protocol and real-client tests. */
import { normalizeIcal, revisionOf, spanOf } from '@supercal/core';
import { calendarAccount, davLogin, member, organization, publication, recordChanges, sourceCalendar, user, withTenant, type CalendarAccount, type SourceCalendar, type TenantId } from '@supercal/db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { eq } from 'drizzle-orm';
import { createFeedService } from '../../src/feeds/service.ts';
import { createCalendar } from '../../src/hosted/calendars.ts';
import { testSecrets } from '../auth-fixture.ts';
import { eventIcs } from './fixture.ts';

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

/** An imported account, its default-feed toggle and a private all-day event with full details. */
export async function seedImported(options: { name?: string; email?: string | null; provider?: Exclude<CalendarAccount['provider'], 'hosted'>; enabled?: boolean; state?: SourceCalendar['state'] } = {}) {
  return withTenant(DEVICE.tenantId, async (tx) => {
    const [account] = await tx.insert(calendarAccount).values({ tenantId: DEVICE.tenantId, ownerUserId: DEVICE.userId,
      provider: options.provider ?? 'google', displayName: 'Imported', email: options.email === undefined ? 'imported@example.test' : options.email,
      autoPublish: options.enabled ?? true }).returning();
    if (!account) throw new Error('No imported account');
    const [calendar] = await tx.insert(sourceCalendar).values({ tenantId: DEVICE.tenantId, accountId: account.id,
      providerCalendarId: 'provider-calendar', name: options.name ?? 'Imported', timezone: 'UTC', state: options.state ?? 'active' }).returning();
    if (!calendar) throw new Error('No imported calendar');
    const pub = await createFeedService(testSecrets).ensurePassthroughPublication(tx, calendar, account);
    await tx.update(publication).set({ privacy: 'busy-only', filters: { hideAllDay: true, hideCancelled: true, hideDeclined: true } }).where(eq(publication.id, pub.id));
    const uid = `private-${calendar.id}`;
    const { resource, completeness } = normalizeIcal([{ id: 'private.ics', etag: '1', groupUid: uid, payload: eventIcs(uid,
      ['DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111', 'CLASS:PRIVATE', 'SUMMARY:Private appointment', 'LOCATION:Secret place', 'DESCRIPTION:Confidential notes']) }]);
    const span = spanOf(resource, 'UTC');
    await recordChanges(tx, [{ op: 'upsert', sourceCalendarId: calendar.id, uid, resource, completeness, revision: revisionOf(resource),
      sequence: 0, lastModified: null, organizer: null,
      span: { start: new Date(span.start.epochMilliseconds), end: span.end === 'infinity' ? 'infinity' : new Date(span.end.epochMilliseconds) } }]);
    return { account, calendar, publication: pub, uid };
  });
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
