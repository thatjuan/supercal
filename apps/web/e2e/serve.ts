/**
 * Playwright's web server (run with Bun): a real daemon (API, CalDAV/ICS and sync worker) on
 * `E2E_PORT` in open sign-up mode, without mail. ICS calendars are served on
 * `http://127.0.0.1:<E2E_FIXTURE_PORT>` (see `fixture.ts`), which the egress allowlist lets the
 * daemon reach.
 */
import { testDatabaseUrl } from '@supercal/db/test-db';
import { serveDaemon } from './daemon.ts';
import { fixtureResponse } from './fixture.ts';

const port = process.env.E2E_PORT;
const fixturePort = process.env.E2E_FIXTURE_PORT;
if (!testDatabaseUrl || !port || !fixturePort) throw new Error('e2e needs TEST_DATABASE_URL, E2E_PORT and E2E_FIXTURE_PORT');

const fixture = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(fixturePort),
  fetch: fixtureResponse,
});

await serveDaemon({
  port,
  database: 'e2e',
  env: { SUPERCAL_SIGNUP: 'open', SUPERCAL_EGRESS_ALLOW: `http://127.0.0.1:${fixturePort}=127.0.0.1/32` },
  onStop: () => void fixture.stop(),
});
