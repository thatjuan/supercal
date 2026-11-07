/** `bun run migrate`: applies the embedded migrations to `DATABASE_MIGRATION_URL ?? DATABASE_URL`. */
import { migrate } from '../src/migrate.ts';

const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: set DATABASE_MIGRATION_URL or DATABASE_URL');
  process.exit(1);
}
const { applied } = await migrate(url);
console.log(`migrate: applied ${applied} migration(s)`);
