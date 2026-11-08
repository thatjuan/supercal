/**
 * Playwright's second web server (run with Bun): a production-shaped daemon on `E2E_VERIFIED_PORT`,
 * with the default `invite` sign-up mode and mail on, so addresses need confirming. `capture-mail.ts`
 * writes its mail to `E2E_MAIL_LOG` instead of sending it.
 */
import { testDatabaseUrl } from '@supercal/db/test-db';
import { serveDaemon } from './daemon.ts';

const port = process.env.E2E_VERIFIED_PORT;
if (!testDatabaseUrl || !port || !process.env.E2E_MAIL_LOG) throw new Error('e2e needs TEST_DATABASE_URL, E2E_VERIFIED_PORT and E2E_MAIL_LOG');

await serveDaemon({
  port,
  database: 'e2e_verified',
  preload: new URL('./capture-mail.ts', import.meta.url).pathname,
  env: { SUPERCAL_SIGNUP: 'invite', RESEND_API_KEY: 'e2e-not-a-key', MAIL_FROM: 'Supercal <supercal@example.invalid>' },
});
