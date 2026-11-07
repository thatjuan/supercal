import { sql } from 'drizzle-orm';
import type { db } from './db';
type Database = typeof db;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
// Connect this pool with a non-owner, NOSUPERUSER NOBYPASSRLS application role.
export function tenantRunner(appDb: Database) {
  return async function withTenant<T>(tenantId: string, run: (tx: Transaction) => Promise<T>): Promise<T> {
    return appDb.transaction(async tx => {
      await tx.execute(sql`select set_config('app.tenant_id',${tenantId},true)`);
      return run(tx);
    });
  };
}
