import type { FeedId, TenantId } from '@supercal/db';
import { beforeAll, expect, test } from 'bun:test';
import { createFeedAuth, type FeedLogin } from './auth.ts';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
let login: FeedLogin;

beforeAll(async () => {
  login = { feedId: 'feed_1' as FeedId, tenantId: 'org_1' as TenantId, passwordHash: await Bun.password.hash('secret', { algorithm: 'argon2id' }) };
});

function setup() {
  let clock = 1_000_000;
  let lookups = 0;
  const auth = createFeedAuth(
    async (username) => (lookups++, username === 'alice' ? login : null),
    () => clock,
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

test('forgetFeed drops cached logins of that feed', async () => {
  const { auth, lookups } = setup();
  await auth.authenticate(basic('alice', 'secret'), 'ip');
  auth.forgetFeed(login.feedId);
  await auth.authenticate(basic('alice', 'secret'), 'ip');
  expect(lookups()).toBe(2);
});

test('ten failures for a username block it with 429 for five minutes, even with the right password', async () => {
  const { auth, advance } = setup();
  for (let i = 0; i < 10; i++) expect(await auth.authenticate(basic('alice', 'wrong'), `ip-${i}`)).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate(basic('alice', 'secret'), 'fresh-ip')).toEqual({ ok: false, status: 429, retryAfter: 300 });
  advance(5 * 60_000);
  expect((await auth.authenticate(basic('alice', 'secret'), 'fresh-ip')).ok).toBe(true);
});

test('ten failures from one IP block it across usernames; failures older than the window do not count', async () => {
  const { auth, advance } = setup();
  for (let i = 0; i < 9; i++) await auth.authenticate(basic(`nobody-${i}`, 'x'), 'attacker');
  advance(5 * 60_000);
  await auth.authenticate(basic('nobody', 'x'), 'attacker');
  expect((await auth.authenticate(basic('alice', 'secret'), 'attacker')).ok).toBe(true);
  for (let i = 0; i < 9; i++) await auth.authenticate(basic(`nobody-${i}`, 'x'), 'attacker');
  expect((await auth.authenticate(basic('alice', 'secret'), 'attacker')).ok).toBe(false);
  expect((await auth.authenticate(basic('alice', 'secret'), 'elsewhere')).ok).toBe(true);
});

test('missing or malformed Authorization is a plain 401', async () => {
  const { auth } = setup();
  expect(await auth.authenticate(undefined, 'ip')).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate('Bearer abc', 'ip')).toEqual({ ok: false, status: 401 });
  expect(await auth.authenticate(`Basic ${btoa('no-colon')}`, 'ip')).toEqual({ ok: false, status: 401 });
});
