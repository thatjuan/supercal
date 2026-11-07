import { describe, expect, test } from 'bun:test';
import { parseConfig } from './config.ts';

const prod = {
  DATABASE_URL: 'postgres://db',
  SUPERCAL_PUBLIC_URL: 'https://cal.example.com',
  SUPERCAL_KEYS: 'k1',
  BETTER_AUTH_SECRET: 's',
};
const dev = { DATABASE_URL: 'x', SUPERCAL_INSECURE_DEV: '1' };

type Case = { rule: string; env: Record<string, string>; problem?: RegExp };

const cases: Case[] = [
  { rule: 'DATABASE_URL is required', env: { ...prod, DATABASE_URL: '' }, problem: /^DATABASE_URL: is required/ },
  { rule: 'production secrets are required', env: { DATABASE_URL: 'x' }, problem: /^SUPERCAL_KEYS: is required unless SUPERCAL_INSECURE_DEV=1/ },
  { rule: 'insecure dev waives production secrets', env: dev },
  { rule: 'public URL must be https', env: { ...prod, SUPERCAL_PUBLIC_URL: 'http://cal.example.com' }, problem: /^SUPERCAL_PUBLIC_URL: must use https:/ },
  { rule: 'insecure dev allows an http public URL', env: { ...dev, SUPERCAL_PUBLIC_URL: 'http://localhost:4316' } },
  { rule: 'roles reject unknown names', env: { ...prod, SUPERCAL_ROLES: 'api,cron' }, problem: /^SUPERCAL_ROLES: must list only api, dav, worker/ },
  { rule: 'signup must be a known mode', env: { ...prod, SUPERCAL_SIGNUP: 'public' }, problem: /^SUPERCAL_SIGNUP:/ },
  { rule: 'migrate must be auto or off', env: { ...prod, SUPERCAL_MIGRATE: 'yes' }, problem: /^SUPERCAL_MIGRATE:/ },
  { rule: 'Google client id needs its secret', env: { ...prod, GOOGLE_CLIENT_ID: 'id' }, problem: /^GOOGLE_CLIENT_ID: must be set together with GOOGLE_CLIENT_SECRET/ },
  { rule: 'Microsoft secret needs its client id', env: { ...prod, MICROSOFT_CLIENT_SECRET: 's' }, problem: /^MICROSOFT_CLIENT_ID: must be set together/ },
  { rule: 'egress allowlist rejects an origin with a path', env: { ...prod, SUPERCAL_EGRESS_ALLOW: 'https://nas.lan/cal=10.0.0.0/24' }, problem: /^SUPERCAL_EGRESS_ALLOW: entries must look like/ },
  { rule: 'egress allowlist rejects a bad CIDR', env: { ...prod, SUPERCAL_EGRESS_ALLOW: 'https://nas.lan=10.0.0.0/33' }, problem: /^SUPERCAL_EGRESS_ALLOW:/ },
  { rule: 'proxy variables are refused in any case', env: { ...prod, https_proxy: 'http://proxy' }, problem: /^https_proxy: must not be set; .*SSRF/ },
];

describe('parseConfig', () => {
  test.each(cases)('$rule', ({ env, problem }) => {
    const result = parseConfig(env);
    if (problem) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems).toContainEqual(expect.stringMatching(problem));
    } else {
      expect(result).toMatchObject({ ok: true });
    }
  });

  test('applies defaults', () => {
    const result = parseConfig(prod);
    if (!result.ok) throw new Error(result.problems.join('\n'));
    expect(result.config).toMatchObject({ PORT: 4316, SUPERCAL_SIGNUP: 'invite', SUPERCAL_MIGRATE: 'auto', SUPERCAL_INSECURE_DEV: false });
    expect([...result.config.SUPERCAL_ROLES]).toEqual(['api', 'dav', 'worker']);
    expect(Object.isFrozen(result.config)).toBe(true);
  });

  test('parses the egress allowlist into exact origins and CIDRs', () => {
    const result = parseConfig({ ...prod, SUPERCAL_EGRESS_ALLOW: 'http://hare:55232=100.103.147.43/32, https://NAS.lan:443=10.0.0.0/24' });
    if (!result.ok) throw new Error(result.problems.join('\n'));
    expect(result.config.SUPERCAL_EGRESS_ALLOW).toEqual([
      { origin: 'http://hare:55232', cidrs: ['100.103.147.43/32'] },
      { origin: 'https://nas.lan', cidrs: ['10.0.0.0/24'] },
    ]);
    const unset = parseConfig(prod);
    expect(unset.ok && unset.config.SUPERCAL_EGRESS_ALLOW).toEqual([]);
  });

  test('never prints values', () => {
    const secret = 'hunter2-not-a-url';
    const result = parseConfig({ DATABASE_URL: 'x', SUPERCAL_PUBLIC_URL: secret, WEB_ORIGIN: secret, HTTP_PROXY: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
    const second = parseConfig({ DATABASE_URL: 'x', SUPERCAL_PUBLIC_URL: secret, SUPERCAL_ROLES: secret });
    expect(JSON.stringify(second)).not.toContain(secret);
  });
});
