import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { migrations } from './migrations.generated.ts';
import { createDatabase } from './unsafe-db.ts';

/** Serialises concurrent boots; advisory locks are per database. */
const MIGRATION_LOCK = 731605012;

/**
 * Applies the embedded migrations to `url` (the schema owner). Holds an advisory lock on a reserved
 * connection throughout, so concurrent callers wait and then find nothing left to apply. Drizzle's
 * migrator only reads folders, so the embedded files go to a temp dir that is removed afterwards.
 * Returns how many migrations this call applied.
 */
export async function migrate(url: string): Promise<{ applied: number }> {
  const db = createDatabase(url, 2);
  const lock = await db.$client.reserve();
  let directory: string | undefined;
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK})`;
    directory = await mkdtemp(join(tmpdir(), 'supercal-migrations-'));
    await mkdir(join(directory, 'meta'));
    await writeFile(join(directory, 'meta', '_journal.json'), JSON.stringify(migrations.journal));
    for (const [name, text] of Object.entries(migrations.files)) await writeFile(join(directory, name), text);
    const before = await appliedCount(db);
    await drizzleMigrate(db, { migrationsFolder: directory });
    return { applied: (await appliedCount(db)) - before };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    await lock`select pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => {});
    lock.release();
    await db.$client.end();
  }
}

async function appliedCount(db: ReturnType<typeof createDatabase>): Promise<number> {
  const [table] = await db.execute<{ exists: boolean }>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`);
  if (!table?.exists) return 0;
  const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from drizzle.__drizzle_migrations`);
  return row?.count ?? 0;
}
