/** Test-only: a Better Auth instance for `signup` mode over `url`, with insecure-dev cookies and an optional mailer. The pool connects lazily. */
import { createControlDatabase, createSecretBox } from '@supercal/db';
import { createAuth, type AuthConfig } from '../src/auth/auth.ts';
import type { Mailer } from '../src/mail/index.ts';

export const TEST_ORIGIN = 'http://localhost:4316';

/** A secret box on the public development key. */
export const testSecrets = await createSecretBox({ insecureDev: true, warn: () => {} });

export function testAuth(signup: AuthConfig['SUPERCAL_SIGNUP'], url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/unused', mailer: Mailer | null = null) {
  const db = createControlDatabase(url, 2);
  const auth = createAuth(
    {
      PORT: 4316,
      SUPERCAL_PUBLIC_URL: TEST_ORIGIN,
      SUPERCAL_SIGNUP: signup,
      SUPERCAL_INSECURE_DEV: true,
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
      WEB_ORIGIN: undefined,
    },
    db,
    mailer,
  );
  return { auth, close: () => db.$client.end() };
}
