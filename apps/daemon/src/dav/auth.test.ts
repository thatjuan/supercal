import type { FeedId, TenantId } from '@supercal/db';
import { beforeAll, expect, test } from 'bun:test';
import { createFeedAuth, type DavLogin } from './auth.ts';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
let login: DavLogin;

beforeAll(async () => {
  login = { kind: 'feed', id: 'feed_1' as FeedId, tenantId: 'org_1' as TenantId, passwordHash: await Bun.password.hash('secret', { algorithm: 'argon2id' }) };
});

function setup() {
  let clock = 1_000_000;
  let lookups = 0;
  const auth = createFeedAuth(
    async (username) => (lookups++, ['alice', 'bob'].includes(username) ? login : null),
    { now: () => clock },
  );
  return { auth, advance: (ms: number) => (clock += ms), lookups: () => lookups };
}

test('a verified login is cached for five minutes, then verified again', async () => {
  const { auth, advance, lookups } = setup();
  expect((await auth.authenticate(basic('alice', 'secret'), 'ip')).ok).toBe(true);
  expect((await auth.authenticate(basic('alice', 'secret'), 'ip')).ok).toBe(true);
  expect(lookups()).toBe(1);
  advance(5 * 60_000);
  expect((await auth.authenticate(basic('alice', 'secret'), 'ip')).ok).toBe(true);
  expect(lookups()).toBe(2);
});

test('forget drops cached logins of that feed', async () => {
  const { auth, lookups } = setup();
  await auth.authenticate(basic('alice', 'secret'), 'ip');
  auth.forget(login.id);
  await auth.authenticate(basic('alice', 'secret'), 'ip');
  expect(lookups()).toBe(2);
});

test('ten failures block only their source and username, leaving other users and sources working', async () => {
  const { auth } = setup();
  for (let i = 0; i < 10; i++) expect(await auth.authenticate(basic('attacker', 'wrong'), 'ip')).toEqual({ ok: false, status: 401 });
  expect((await auth.authenticate(basic('alice', 'secret'), 'ip')).ok).toBe(true);
  expect((await auth.authenticate(basic('bob', 'secret'), 'ip')).ok).toBe(true);
  expect(await auth.authenticate(basic('attacker', 'wrong'), 'ip')).toEqual({ ok: false, status: 429, retryAfter: 300 });
  expect(await auth.authenticate(basic('attacker', 'wrong'), 'another-ip')).toEqual({ ok: false, status: 401 });
});

test('a cached valid login succeeds even when its source and username are blocked', async () => {
  const { auth } = setup();
  expect((await auth.authenticate(basic('alice', 'secret'), 'ip')).ok).toBe(true);
  for (let i = 0; i < 10; i++) await auth.authenticate(basic('alice', 'wrong'), 'ip');
  expect(await auth.authenticate(basic('alice', 'wrong'), 'ip')).toEqual({ ok: false, status: 429, retryAfter: 300 });
  expect((await auth.authenticate(basic('alice', 'secret'), 'ip')).ok).toBe(true);
});

test('a block lapses after five minutes, and ten more failures renew it', async () => {
  const { auth, advance } = setup();
  for (let i = 0; i < 10; i++) await auth.authenticate(basic('attacker', 'wrong'), 'ip');
  advance(5 * 60_000 - 1_000);
  expect(await auth.authenticate(basic('attacker', 'wrong'), 'ip')).toEqual({ ok: false, status: 429, retryAfter: 1 });
  advance(1_000);
  for (let i = 0; i < 10; i++) expect(await auth.authenticate(basic('attacker', 'wrong'), 'ip')).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate(basic('attacker', 'wrong'), 'ip')).toEqual({ ok: false, status: 429, retryAfter: 300 });
});

test('40 concurrent wrong passwords for one username verify at most ten times', async () => {
  let verifications = 0;
  const auth = createFeedAuth(async () => login, { verify: async () => { verifications++; return false; } });
  const results = await Promise.all(Array.from({ length: 40 }, () => auth.authenticate(basic('alice', 'wrong'), 'ip')));
  expect(verifications).toBe(10);
  expect(results.filter((result) => !result.ok && result.status === 401)).toHaveLength(10);
  expect(results.filter((result) => !result.ok && result.status === 429)).toHaveLength(30);
});

test('100 distinct usernames run at most four verifications, queue 64 and reject overflow', async () => {
  let active = 0;
  let peak = 0;
  let verifications = 0;
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const auth = createFeedAuth(async (username) => username === 'unknown' ? null : login, {
    verify: async () => {
      verifications++;
      peak = Math.max(peak, ++active);
      if (active === 4) started.resolve();
      await gate.promise;
      active--;
      return false;
    },
  });
  const requests = Array.from({ length: 100 }, (_, i) => auth.authenticate(basic(`user-${i}`, 'wrong'), 'ip'));
  await started.promise;
  expect(active).toBe(4);
  expect(await auth.authenticate(basic('unknown', 'wrong'), 'ip')).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate(basic('overflow', 'wrong'), 'ip')).toEqual({ ok: false, status: 429, retryAfter: 5 });
  gate.resolve();
  const results = await Promise.all(requests);
  expect(peak).toBe(4);
  expect(verifications).toBe(68);
  expect(results.filter((result) => !result.ok && result.status === 401)).toHaveLength(68);
  expect(results.filter((result) => !result.ok && result.status === 429 && result.retryAfter === 5)).toHaveLength(32);
  // Overflow releases its source+username reservation, and verifier slots return to the pool.
  expect(await auth.authenticate(basic('overflow', 'wrong'), 'ip')).toEqual({ ok: false, status: 401 });
});

test('missing or malformed Authorization is a plain 401', async () => {
  const { auth } = setup();
  expect(await auth.authenticate(undefined, 'ip')).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate('Bearer abc', 'ip')).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate(`Basic ${btoa('no-colon')}`, 'ip')).toEqual({ ok: false, status: 401 });
});
