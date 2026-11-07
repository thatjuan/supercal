import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './auth-schema';
export const databaseURL = process.env.DATABASE_URL ?? 'postgres://supercal:spike@hare:55432/spike_platform';
export const client = postgres(databaseURL, { max: 8, onnotice: () => {} });
export const db = drizzle(client, { schema });
