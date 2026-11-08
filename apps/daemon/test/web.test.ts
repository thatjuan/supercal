/** Dashboard serving (no database) and the public instance endpoint (scratch database), through the whole app. */
import { closeDb, connectDb, migrate } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idleBus } from '../src/bus.ts';
import { createApp } from '../src/http.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const fixture = testAuth('open');
let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'supercal-web-'));
  await mkdir(join(dir, 'assets'));
  await Bun.write(join(dir, 'index.html'), '<!doctype html><title>Supercal</title>');
  await Bun.write(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  await Bun.write(join(dir, 'favicon.svg'), '<svg/>');
  app = createApp(new Set(['api']), { auth: fixture.auth, secrets: testSecrets, bus: idleBus, icsCacheBytes: 0, webDir: dir });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await fixture.close();
});

describe('dashboard serving', () => {
  test('hashed assets are cached for a year', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(1)');
  });

  test('other files and client routes revalidate; routes fall back to index.html', async () => {
    const icon = await app.request('/favicon.svg');
    expect(icon.headers.get('cache-control')).toBe('no-cache');
    for (const path of ['/', '/accounts', '/invite/abc']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>Supercal</title>');
    }
  });

  test('a missing hashed asset and daemon paths are not swallowed by the fallback', async () => {
    expect((await app.request('/assets/gone-123.js')).status).toBe(404);
    const api = await app.request('/api/v1/nope');
    expect(api.headers.get('content-type')).not.toContain('text/html');
    expect((await app.request('/.well-known/caldav')).headers.get('content-type') ?? '').not.toContain('text/html');
  });

  test('paths cannot escape the web directory', async () => {
    const res = await app.request('/..%2f..%2fetc%2fpasswd');
    expect(await res.text()).toContain('<title>Supercal</title>');
  });
});

describe.skipIf(!testDatabaseUrl)('GET /api/v1/instance', () => {
  let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
  let instanceFixture: ReturnType<typeof testAuth>;

  beforeAll(async () => {
    scratch = await scratchDatabase('instance');
    await migrate(scratch.url);
    connectDb(scratch.url);
    instanceFixture = testAuth('disabled', scratch.url);
  });

  afterAll(async () => {
    await instanceFixture.close();
    await closeDb();
    await scratch.drop();
  });

  test('is public, reports the configured mode and providers, and needs setup until the first user signs up', async () => {
    const google = { clientId: 'id', clientSecret: 'secret', authorizeUrl: 'https://accounts.example/auth', tokenUrl: 'https://accounts.example/token' };
    const oauth = { stateSecret: 'state-secret', google };
    const deps = { auth: instanceFixture.auth, secrets: testSecrets, bus: idleBus, icsCacheBytes: 0, signup: 'disabled', oauth } as const;
    const api = createApp(new Set(['api']), deps);
    const instance = { signup: 'disabled', providers: { google: true, microsoft: false } };
    const read = async () => (await api.request('/api/v1/instance')).json();
    expect(await read()).toEqual({ ...instance, setupRequired: true });

    const signUp = await api.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin: 'http://localhost:4316', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.invalid', password: 'correct-horse-battery', name: 'First' }),
    });
    expect(signUp.status).toBe(200);
    expect(await read()).toEqual({ ...instance, setupRequired: false });
  });
});
