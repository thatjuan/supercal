import { defineConfig } from 'drizzle-kit';

/** Generation only (`generate`, `check`); migrations are applied by `src/migrate.ts`, never by drizzle-kit. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
