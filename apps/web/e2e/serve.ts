/**
 * Playwright's web server (run with Bun): a real daemon over a fresh `<TEST_DATABASE_URL>_e2e`
 * database, serving the built dashboard (`dist/`), CalDAV and ICS on `E2E_PORT` in open sign-up mode, so
 * the browser talks to it same-origin exactly as in production.
 */
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';

const port = process.env.E2E_PORT;
if (!testDatabaseUrl || !port) throw new Error('e2e needs TEST_DATABASE_URL and E2E_PORT');

const scratch = await scratchDatabase('e2e');
const origin = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(['bun', new URL('../../daemon/src/main.ts', import.meta.url).pathname], {
  env: {
    ...process.env,
    PORT: port,
    DATABASE_URL: scratch.url,
    SUPERCAL_PUBLIC_URL: origin,
    SUPERCAL_INSECURE_DEV: '1',
    SUPERCAL_SIGNUP: 'open',
    SUPERCAL_ROLES: 'api,dav',
    SUPERCAL_WEB_DIR: new URL('../dist', import.meta.url).pathname,
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

// Playwright signals the whole process group; either way, the database goes once the daemon exits.
const stop = () => daemon.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const code = await daemon.exited;
await scratch.drop();
process.exit(code);
