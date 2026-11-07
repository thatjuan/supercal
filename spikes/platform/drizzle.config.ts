import { defineConfig } from 'drizzle-kit';
export default defineConfig({schema: ['./src/auth-schema.ts','./src/platform-schema.ts'], out:'./migrations', dialect:'postgresql', dbCredentials:{url: process.env.DATABASE_URL ?? 'postgres://supercal:spike@hare:55432/spike_platform'}});
