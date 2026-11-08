/**
 * Smoke test of a release build.
 *
 *   bun scripts/smoke-compiled.ts [dist/supercal]   # needs TEST_DATABASE_URL
 *   bun scripts/smoke-compiled.ts --url http://host:port
 *
 * Binary mode starts two copies of the binary at once from an empty temp dir, against a fresh
 * scratch database beside `TEST_DATABASE_URL`, and checks that exactly one applied the migrations
 * (the advisory lock) before both became ready. URL mode checks an install that is already
 * running (such as the container), which must run with `SUPERCAL_PUBLIC_URL` set to that URL and
 * signup open (or no user yet). Both then check: `/readyz` is 200, sign-up works, the dashboard
 * index is served, and a PROPFIND on `/.well-known/caldav` redirects to `/dav/`.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The `applied` count of a daemon log line, when it is the `migrations applied` line. */
const appliedIn = (line: string): number[] => {
  try {
    const entry: unknown = JSON.parse(line);
    if (typeof entry === 'object' && entry !== null && 'msg' in entry && entry.msg === 'migrations applied' && 'applied' in entry && typeof entry.applied === 'number')
      return [entry.applied];
  } catch {}
  return [];
};

/** A port that was free a moment ago. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) throw new Error('no free port');
  return port;
}

/** Polls `base/readyz` until it answers 200; returns the elapsed ms since `since`. */
async function untilReady(base: string, since: number, timeoutMs = 20_000): Promise<number> {
  let last = 'no answer';
  while (performance.now() - since < timeoutMs) {
    try {
      const res = await fetch(`${base}/readyz`);
      if (res.ok) return Math.round(performance.now() - since);
      last = `${res.status} ${await res.text()}`;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error(`${base} never became ready (last: ${last})`);
}

/** The checks every install must pass. */
async function checkInstall(base: string) {
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200, `/readyz: ${await ready.text()}`);

  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: `smoke-${crypto.randomUUID()}@example.invalid`, password: 'smoke-test-password-123', name: 'Smoke Test' }),
  });
  assert.equal(signup.status, 200, `sign-up: ${await signup.text()}`);
  const cookie = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await fetch(`${base}/api/v1/me`, { headers: { cookie } });
  assert.equal(me.status, 200, `/api/v1/me after sign-up: ${await me.text()}`);

  const index = await fetch(`${base}/`);
  const html = await index.text();
  assert.equal(index.status, 200);
  assert.match(html, /<div id="root"><\/div>/, 'the dashboard index is served');
  assert.match(html, /\/assets\/index-[\w-]+\.js/, 'the index references the built bundle');

  const discovery = await fetch(`${base}/.well-known/caldav`, { method: 'PROPFIND', redirect: 'manual', headers: { depth: '0' } });
  assert.equal(discovery.status, 301);
  assert.equal(new URL(discovery.headers.get('location') ?? '', base).pathname, '/dav/');
  return { readyz: ready.status, signup: signup.status, me: me.status, dashboard: index.status, caldavDiscovery: discovery.status };
}

/** Starts two binaries at once on a scratch database and checks the migration lock, then the install. */
async function smokeBinary(binary: string) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('set TEST_DATABASE_URL (a throwaway Postgres database)');
  // Imported here: the module warns when TEST_DATABASE_URL is unset, which URL mode does not need.
  const { scratchDatabase } = await import('../packages/db/src/test-db.ts');
  const database = await scratchDatabase('smoke');
  const cwd = await mkdtemp(join(tmpdir(), 'supercal-smoke-'));
  const ports = [freePort(), freePort()];
  const started = performance.now();
  const children = ports.map((port) =>
    Bun.spawn([binary], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        PORT: String(port),
        DATABASE_URL: database.url,
        SUPERCAL_PUBLIC_URL: `http://localhost:${port}`,
        SUPERCAL_INSECURE_DEV: '1',
        SUPERCAL_SIGNUP: 'open',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  try {
    const readyMs = await Promise.all(ports.map((port) => untilReady(`http://localhost:${port}`, started)));
    const result = await checkInstall(`http://localhost:${ports[0]}`);
    return { binary, binaryBytes: Bun.file(binary).size, readyMs, ...result, children };
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => child.exited));
    await rm(cwd, { recursive: true, force: true });
    await database.drop();
  }
}

const urlFlag = process.argv.indexOf('--url');
if (urlFlag !== -1) {
  const base = (process.argv[urlFlag + 1] ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('--url needs a base URL');
  console.log(JSON.stringify({ base, ...(await checkInstall(base)) }, null, 2));
} else {
  const { children, ...report } = await smokeBinary(resolve(process.argv[2] ?? 'dist/supercal'));
  const logs = await Promise.all(children.map(async (child) => (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())));
  const applied = logs.map((text) =>
    text
      .split('\n')
      .flatMap(appliedIn)
      .at(0),
  );
  const exits = children.map((child) => child.exitCode);
  assert.deepEqual(exits, [0, 0], `both binaries exit cleanly on SIGTERM:\n${logs.join('\n---\n')}`);
  assert.equal(applied.filter((n) => n === 0).length, 1, `exactly one binary found nothing left to apply: ${JSON.stringify(applied)}`);
  assert.ok(applied.some((n) => n !== undefined && n > 0), 'the other applied every migration');
  console.log(JSON.stringify({ ...report, migrationsApplied: applied, exits }, null, 2));
}
