import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild } from './child.ts';

// Each case runs in a child process: trust roots are fixed per process, and the spike saw TLS trust
// configuration reused across requests within one process.
const temp = mkdtempSync(join(tmpdir(), 'supercal-tls-'));
const certPath = join(temp, 'cert.pem');
let server: ReturnType<typeof Bun.serve>;
const trusted = { NODE_EXTRA_CA_CERTS: certPath };

beforeAll(() => {
  const keyPath = join(temp, 'key.pem');
  const openssl = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=calendar.test', '-addext', 'subjectAltName=DNS:calendar.test']);
  if (openssl.exitCode !== 0) throw new Error(openssl.stderr.toString());
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') },
    fetch: (req) => (new URL(req.url).pathname === '/downgrade' ? Response.redirect(`http://calendar.test:${server.port}/`) : new Response(req.headers.get('host'))),
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(temp, { recursive: true });
});

test('pinned IP with a trusted certificate for the original hostname passes', async () => {
  expect(await runChild(`https://calendar.test:${server.port}/`, trusted)).toEqual({ ok: true, status: 200, body: `calendar.test:${server.port}` });
});

test('certificate for a different hostname is rejected', async () => {
  expect(await runChild(`https://wrong.test:${server.port}/`, trusted)).toMatchObject({ ok: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('untrusted chain is rejected', async () => {
  const outcome = await runChild(`https://calendar.test:${server.port}/`);
  expect(outcome).toMatchObject({ ok: false });
  expect(outcome.ok === false && outcome.message).toContain('self signed');
});

test('redirect from https to http is refused', async () => {
  expect(await runChild(`https://calendar.test:${server.port}/downgrade`, trusted)).toMatchObject({ ok: false, reason: 'downgrade' });
});
