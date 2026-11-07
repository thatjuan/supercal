/**
 * The process-wide connection pool. `unsafeDb()` bypasses tenant isolation (it runs as the login
 * role), so only migrations, `tx.ts` and tests may import this module; everything else goes
 * through `withTenant` / `withControl`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

/** Opens a pool on `url`, quiet about server notices. */
export const createDatabase = (url: string, max = 10) => drizzle({ client: postgres(url, { max, onnotice: () => {} }), schema });

export type Database = ReturnType<typeof createDatabase>;

let current: Database | undefined;

/** Opens the shared pool. Call once at boot, or in test setup. */
export function connectDb(url: string): void {
  if (current) throw new Error('database already connected');
  current = createDatabase(url);
}

/** Closes the shared pool, letting queries in flight finish. */
export async function closeDb(): Promise<void> {
  await current?.$client.end();
  current = undefined;
}

/** The raw, unscoped handle. Throws until `connectDb` has run. */
export function unsafeDb(): Database {
  if (!current) throw new Error('database not connected; call connectDb first');
  return current;
}
