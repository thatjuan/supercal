/** The Python client changes the grant between requests to check token invalidation. */
import { calendarShare, connectDb, closeDb, withTenant } from '@supercal/db';
import { and, eq } from 'drizzle-orm';
import { DEVICE } from '../hosted-fixture.ts';

connectDb(process.env.DATABASE_URL!);
try {
  await withTenant(DEVICE.tenantId, (tx) => tx.update(calendarShare).set({ access: 'write', updatedAt: new Date() })
    .where(and(eq(calendarShare.granteeUserId, 'shared_dav_reader'), eq(calendarShare.tenantId, DEVICE.tenantId))));
} finally { await closeDb(); }
