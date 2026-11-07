import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, admin, openAPI } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { db } from './db';
import * as schema from './auth-schema';
export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET ?? 'spike-only-secret-do-not-use-in-production-123456789',
  baseURL: process.env.BASE_URL ?? 'http://localhost:4316',
  ...(process.env.WEB_ORIGIN ? {trustedOrigins:[process.env.WEB_ORIGIN]} : {}),
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  plugins: [organization(), admin(), apiKey([
    { configId: 'default', references: 'user', enableMetadata: true },
    { configId: 'tenant', references: 'organization', enableMetadata: true },
  ]), openAPI()],
});
