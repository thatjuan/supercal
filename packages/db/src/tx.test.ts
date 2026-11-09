import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { recordChanges, resourcesIn } from './changes.ts';
import { newId, type TenantId } from './ids.ts';
import { migrate } from './migrate.ts';
import { calendarAccount, feed, organization, resource, sourceCalendar, user } from './schema/index.ts';
import { sqlState, testDatabaseUrl } from './test-db.ts';
import { withControl, withTenant, type DrizzleTx, type TenantTx } from './tx.ts';
import { closeDb, connectDb, unsafeDb } from './unsafe-db.ts';

const tenantA = `org_${crypto.randomUUID()}` as TenantId;
const tenantB = `org_${crypto.randomUUID()}` as TenantId;
const userId = `user_${crypto.randomUUID()}`;
const accountA = newId('acc');
const accountB = newId('acc');

const account = (id: typeof accountA, tenantId: TenantId) => ({
  id,
  tenantId,
  ownerUserId: userId,
  provider: 'ics' as const,
  displayName: `account in ${tenantId}`,
});

describe.skipIf(!testDatabaseUrl)('tenant isolation', () => {
  beforeAll(async () => {
    const url = testDatabaseUrl ?? '';
    await migrate(url);
    connectDb(url);
    const db = unsafeDb();
    const now = new Date();
    await db.insert(user).values({ id: userId, name: 'Test', email: `${userId}@example.com`, updatedAt: now });
    await db.insert(organization).values([tenantA, tenantB].map((id) => ({ id, name: id, slug: id, createdAt: now })));
    await db.insert(calendarAccount).values([account(accountA, tenantA), account(accountB, tenantB)]);
    await db.insert(feed).values(
      [tenantA, tenantB].map((tenantId) => ({ tenantId, ownerUserId: userId, name: 'Feed', caldavUsername: `u-${crypto.randomUUID()}`, uidSecret: 'sc1.x' })),
    );
  });

  afterAll(async () => {
    await unsafeDb().delete(organization).where(inArray(organization.id, [tenantA, tenantB]));
    await unsafeDb().delete(user).where(eq(user.id, userId));
    await closeDb();
  });

  test('a query without WHERE sees only the current tenant, as supercal_app', async () => {
    const seen = await withTenant(tenantA, async (tx) => {
      const [role] = await tx.execute<{ current_user: string }>(sql`select current_user`);
      return { role: role?.current_user, accounts: await tx.select({ id: calendarAccount.id }).from(calendarAccount) };
    });
    expect(seen).toEqual({ role: 'supercal_app', accounts: [{ id: accountA }] });
  });

  test('a cross-tenant insert fails with 42501', async () => {
    const insert = withTenant(tenantA, (tx) => tx.insert(calendarAccount).values(account(newId('acc'), tenantB)));
    expect(await sqlState(insert)).toBe('42501');
  });

  test('a following transaction without a tenant sees zero rows', async () => {
    const rows = await unsafeDb().transaction(async (tx) => {
      await tx.execute(sql`set local role supercal_app`);
      return tx.select().from(calendarAccount);
    });
    expect(rows).toEqual([]);
  });

  test('resource spans round-trip and are queryable by overlap', async () => {
    const span = { start: new Date('2026-03-01T09:00:00Z'), end: 'infinity' as const };
    const found = await withTenant(tenantA, async (tx) => {
      const calendarId = newId('cal');
      await tx.insert(sourceCalendar).values({ id: calendarId, tenantId: tenantA, accountId: accountA, providerCalendarId: 'c', name: 'C' });
      const resource = { uid: 'u1', master: null, overrides: [], timezones: {} };
      await recordChanges(tx, [
        { op: 'upsert', sourceCalendarId: calendarId, uid: 'u1', resource, revision: 'r', sequence: null, lastModified: null, organizer: null, span, completeness: 'complete' },
      ]);
      return resourcesIn(tx, [calendarId], { from: new Date('2030-01-01'), to: new Date('2030-01-02') });
    });
    expect(found.map((row) => row.span)).toEqual([span]);
  });

  test('supercal_control reads lookup columns across tenants but no event data or secrets', async () => {
    const tenants = await withControl((tx) => tx.select({ tenantId: feed.tenantId }).from(feed));
    expect(tenants.map((row) => row.tenantId)).toEqual(expect.arrayContaining([tenantA, tenantB]));
    expect(await sqlState(withControl((tx) => tx.select({ secret: feed.uidSecret }).from(feed)))).toBe('42501');
    expect(await sqlState(withControl((tx) => tx.select().from(resource)))).toBe('42501');
    expect(await sqlState(withControl((tx) => tx.select().from(calendarAccount)))).toBe('42501');
    expect(await sqlState(withControl((tx) => tx.select({ provider: calendarAccount.provider }).from(calendarAccount)))).toBe('42501');
  });

  test('supercal_control reads live resource metadata but cannot read event columns or delete live rows', async () => {
    const calendarId = newId('cal');
    const { maxSeq } = await withTenant(tenantA, async (tx) => {
      await tx.insert(sourceCalendar).values({ id: calendarId, tenantId: tenantA, accountId: accountA, providerCalendarId: 'control-metadata', name: 'C' });
      return recordChanges(tx, [{ op: 'upsert', sourceCalendarId: calendarId, uid: 'control-live', resource: { uid: 'control-live', master: null, overrides: [], timezones: {} }, revision: 'secret', sequence: null, lastModified: null, organizer: null, span: { start: new Date('2026-11-09T09:00:00Z'), end: new Date('2026-11-09T10:00:00Z') }, completeness: 'complete' }]);
    });
    const rows = await withControl((tx) => tx.select({ calendarId: resource.sourceCalendarId, seq: resource.seq, changedAt: resource.changedAt, deleted: resource.deleted }).from(resource).where(eq(resource.sourceCalendarId, calendarId)));
    expect(rows).toEqual([{ calendarId, seq: maxSeq!, changedAt: expect.any(Date), deleted: false }]);
    for (const column of [resource.data, resource.uid, resource.revision, resource.tenantId])
      expect(await sqlState(withControl((tx) => tx.select({ denied: column }).from(resource)))).toBe('42501');
    // Attempt a live-row deletion without the purge's own deleted predicate, exercising RLS itself.
    const deleted = await withControl((tx) => tx.execute(sql`delete from ${resource} where ${resource.sourceCalendarId} = ${calendarId} returning ${resource.seq}`));
    expect(deleted).toHaveLength(0);
    expect(await withTenant(tenantA, (tx) => resourcesIn(tx, [calendarId]))).toHaveLength(1);
  });

  test('supercal_control can delete a tenant, cascading through its RLS tables', async () => {
    await withControl((tx) => tx.delete(organization).where(eq(organization.id, tenantB)));
    expect(await unsafeDb().select().from(calendarAccount).where(eq(calendarAccount.tenantId, tenantB))).toEqual([]);
  });

  test('a raw transaction is not a TenantTx', () => {
    const wantsTenantTx = (tx: TenantTx) => tx;
    // @ts-expect-error only withTenant hands out a TenantTx
    const misuse = (tx: DrizzleTx) => wantsTenantTx(tx);
    expect(misuse).toBeFunction();
  });
});
