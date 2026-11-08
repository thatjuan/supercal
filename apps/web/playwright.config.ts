/**
 * `bun run test:e2e` (needs TEST_DATABASE_URL): builds the dashboard, starts a real daemon on a
 * free port through `e2e/serve.ts`, and drives it in Chromium.
 */
import { defineConfig, devices } from '@playwright/test';
import { createServer } from 'node:net';

/** A port the OS says is free right now; workers inherit it through the environment. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });

process.env.E2E_PORT ??= String(await freePort());
/** Where `e2e/serve.ts` serves the ICS fixture; the e2e connects it as an account. */
process.env.E2E_FIXTURE_PORT ??= String(await freePort());
const baseURL = `http://127.0.0.1:${process.env.E2E_PORT}`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'bun e2e/serve.ts',
    url: `${baseURL}/healthz`,
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
