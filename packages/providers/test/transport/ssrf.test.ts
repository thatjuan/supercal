import { afterAll, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { createGuardedFetch, credentialTarget, EgressBlockedError, type EgressPolicy, type Resolver } from '../../src/transport/index.ts';
import { isPublicIp, normalizeUrl, resolveTarget } from '../../src/transport/policy.ts';
import { runChild } from './child.ts';

let calls = 0;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    calls++;
    const url = new URL(req.url);
    switch (url.pathname) {
      case '/redirect-private':
        return Response.redirect('http://169.254.169.254/latest/meta-data/');
      case '/loop':
        return Response.redirect('/loop');
      case '/redirect':
        return Response.redirect('/host');
      case '/cross':
        return Response.redirect(`http://other.test:${url.port}/headers`);
      case '/slow':
        await Bun.sleep(200);
        return new Response('late');
      case '/big':
        return new Response('x'.repeat(2000));
      case '/bomb':
        return new Response(gzipSync('x'.repeat(50_000)), { headers: { 'Content-Encoding': 'gzip' } });
      case '/gzip':
        return new Response(gzipSync('BEGIN:VCALENDAR'), { headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/octet-stream' } });
      case '/headers':
        return Response.json(Object.fromEntries(['authorization', 'cookie', 'if-none-match', 'if-modified-since'].map((h) => [h, req.headers.get(h)])));
      default:
        return new Response(req.headers.get('host'));
    }
  },
});
afterAll(() => server.stop(true));

const origin = `http://calendar.test:${server.port}`;
const other = `http://other.test:${server.port}`;
const loopback: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
const lanAllow: EgressPolicy['allow'] = [
  { origin, cidrs: ['127.0.0.1/32'] },
  { origin: other, cidrs: ['127.0.0.1/32'] },
];
const guarded = createGuardedFetch({ allow: lanAllow }, { resolve: loopback });
const text = (body: Uint8Array) => new TextDecoder().decode(body);

/** The `EgressBlockedError` reason `work` fails with, or the other error it threw. */
async function reasonOf(work: () => unknown) {
  try {
    await work();
  } catch (error) {
    return error instanceof EgressBlockedError ? error.reason : error;
  }
  return 'no error';
}

const blockedForms = ['127.0.0.1', '127.255.255.255', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '224.0.0.1', '240.0.0.1', '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1', '64:ff9b::a00:1', '2001:db8::1'];
test.each(blockedForms)('blocks %s', (ip) => expect(isPublicIp(ip)).toBe(false));

test('public address examples', () => {
  expect(isPublicIp('1.1.1.1')).toBe(true);
  expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
});

test('URL normalisation blocks numeric IPv4 tricks, maps webcal, rejects other schemes and userinfo', async () => {
  for (const input of ['http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1', 'http://[::ffff:127.0.0.1]']) {
    expect(await reasonOf(() => resolveTarget(normalizeUrl(input), [], loopback, AbortSignal.timeout(1000)))).toBe('address');
  }
  expect(normalizeUrl('webcal://example.com/a').href).toBe('https://example.com/a');
  expect(await reasonOf(() => normalizeUrl('file:///etc/passwd'))).toBe('scheme');
  expect(await reasonOf(() => normalizeUrl('http://user:pass@example.com'))).toBe('credentials-in-url');
});

test('mixed public/private DNS answer rejected', async () => {
  const mixed: Resolver = async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ];
  expect(await reasonOf(() => resolveTarget(new URL('http://calendar.test'), [], mixed, AbortSignal.timeout(1000)))).toBe('mixed-dns');
});

test('LAN rejected without operator allowlist; exact origin+CIDR permits it and Host survives the IP dial', async () => {
  expect(await reasonOf(() => createGuardedFetch({ allow: [] }, { resolve: loopback })({ url: `${origin}/host` }))).toBe('address');
  const logged: unknown[] = [];
  const allowed = createGuardedFetch({ allow: lanAllow }, { resolve: loopback, log: (entry) => logged.push(entry) });
  const response = await allowed({ url: `${origin}/host?token=secret` });
  expect(text(response.body)).toBe(`calendar.test:${server.port}`);
  expect(logged).toEqual([{ host: `calendar.test:${server.port}`, status: 200 }]);
  const wrongCidr = createGuardedFetch({ allow: [{ origin, cidrs: ['192.168.0.0/16'] }] }, { resolve: loopback });
  expect(await reasonOf(() => wrongCidr({ url: `${origin}/host` }))).toBe('address');
});

test('pinning uses one DNS answer without resolving the name at connect time', async () => {
  let lookups = 0;
  const rebinding = createGuardedFetch({ allow: lanAllow }, { resolve: async () => [{ address: ++lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }] });
  const response = await rebinding({ url: `${origin}/host` });
  expect(lookups).toBe(1);
  expect(text(response.body)).toBe(`calendar.test:${server.port}`);
});

test('redirect rechecks DNS and rejects metadata before connection', async () => {
  const before = calls;
  expect(await reasonOf(() => guarded({ url: `${origin}/redirect-private` }))).toBe('address');
  expect(calls - before).toBe(1);
  let lookups = 0;
  const rebinding = createGuardedFetch({ allow: lanAllow }, { resolve: async () => [{ address: ++lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }] });
  expect(await reasonOf(() => rebinding({ url: `${origin}/redirect` }))).toBe('address');
  expect(lookups).toBe(2);
});

test('redirect count, deadline and body bounds', async () => {
  expect(await reasonOf(() => guarded({ url: `${origin}/loop`, maxRedirects: 2 }))).toBe('too-many-redirects');
  await expect(guarded({ url: `${origin}/slow`, timeoutMs: 30 })).rejects.toMatchObject({ name: 'TimeoutError' });
  await expect(guarded({ url: `${origin}/big`, maxBytes: 1000 })).rejects.toThrow('Body too large');
  await expect(guarded({ url: `${origin}/bomb`, maxBytes: 1000 })).rejects.toThrow('Body too large');
  const slowDns = createGuardedFetch({ allow: lanAllow }, { resolve: async () => (await Bun.sleep(100), []) });
  await expect(slowDns({ url: origin, timeoutMs: 20 })).rejects.toMatchObject({ name: 'TimeoutError' });
});

test('gzip with sloppy MIME is decoded after a same-origin redirect', async () => {
  const response = await guarded({ url: `${origin}/gzip` });
  expect(text(response.body)).toBe('BEGIN:VCALENDAR');
  const redirected = await guarded({ url: `${origin}/redirect` });
  expect(redirected.finalUrl).toBe(`${origin}/host`);
});

test('cross-origin redirects drop credentials, cookies and conditional headers unless the origin is trusted', async () => {
  const req = {
    url: `${origin}/cross`,
    headers: { Cookie: 'a=1', 'If-None-Match': '"v1"', 'If-Modified-Since': 'Sat, 07 Nov 2026 00:00:00 GMT' },
    credentials: { kind: 'basic', username: 'u', password: 'p' },
  } as const;
  const stripped = await guarded(req);
  expect(stripped.finalUrl).toBe(`${other}/headers`);
  expect(JSON.parse(text(stripped.body))).toEqual({ authorization: null, cookie: null, 'if-none-match': null, 'if-modified-since': null });
  const kept = await guarded({ ...req, credentialOrigins: [other] });
  expect(JSON.parse(text(kept.body))).toEqual({
    authorization: `Basic ${btoa('u:p')}`,
    cookie: 'a=1',
    'if-none-match': '"v1"',
    'if-modified-since': 'Sat, 07 Nov 2026 00:00:00 GMT',
  });
});

test('ambient proxy is rejected before network access', async () => {
  let proxied = 0;
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => (proxied++, new Response('PROXY_USED')) });
  try {
    const href = proxy.url.href;
    const outcome = await runChild(`${origin}/host`, { HTTP_PROXY: href, https_proxy: href, ALL_PROXY: href, NO_PROXY: '' });
    expect(outcome).toMatchObject({ ok: false, reason: 'proxy-env' });
    expect(proxied).toBe(0);
  } finally {
    proxy.stop(true);
  }
});

test('refused, mixed, empty and failed DNS answers share a tenant message; addresses stay in operator logs', async () => {
  const cases: { resolve: Resolver; reason: EgressBlockedError['reason']; address?: string }[] = [
    { resolve: loopback, reason: 'address', address: '127.0.0.1' },
    { resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.2.3.4', family: 4 }], reason: 'mixed-dns', address: '10.2.3.4' },
    { resolve: async () => [], reason: 'unresolved' },
    { resolve: async () => { throw new Error('DNS failed at 192.168.1.2'); }, reason: 'unresolved' },
  ];
  for (const { resolve, reason, address } of cases) {
    const logged: unknown[] = [];
    const fetch = createGuardedFetch({ allow: [] }, { resolve, log: (entry) => logged.push(entry) });
    try {
      await fetch({ url: 'https://calendar.test/private' });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(EgressBlockedError);
      if (!(error instanceof EgressBlockedError)) throw error;
      expect(error.message).toBe('The destination calendar.test is blocked or could not be resolved');
      expect(error.reason).toBe(reason);
      expect(error.address).toBe(address);
      expect(logged).toEqual([{ host: 'calendar.test', reason, ...(address && { address }) }]);
    }
  }
});

test('same-hostname redirects to another port drop Authorization', async () => {
  let received: string | null = 'not called';
  const destination = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => { received = req.headers.get('authorization'); return new Response('ok'); } });
  const source = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.redirect(`http://calendar.test:${destination.port}/`) });
  try {
    const sourceOrigin = `http://calendar.test:${source.port}`;
    const destinationOrigin = `http://calendar.test:${destination.port}`;
    const fetch = createGuardedFetch({ allow: [sourceOrigin, destinationOrigin].map((origin) => ({ origin, cidrs: ['127.0.0.1/32'] })) }, { resolve: loopback });
    await fetch({ url: sourceOrigin, credentials: { kind: 'basic', username: 'u', password: 'p' }, credentialOrigins: [sourceOrigin], credentialHosts: ['calendar.test'] });
    expect(received).toBeNull();
  } finally {
    source.stop(true);
    destination.stop(true);
  }
});

test('credential hosts require HTTPS on the default port; exact origins preserve configured ports', () => {
  const hosts = ['caldav.icloud.com', '*.icloud.com'];
  expect(credentialTarget(new URL('https://p42-caldav.icloud.com'), [], hosts)).toBe(true);
  expect(credentialTarget(new URL('https://p42-caldav.icloud.com:443'), [], hosts)).toBe(true);
  expect(credentialTarget(new URL('https://p42-caldav.icloud.com:8443'), [], hosts)).toBe(false);
  expect(credentialTarget(new URL('http://p42-caldav.icloud.com'), [], hosts)).toBe(false);
  expect(credentialTarget(new URL('https://caldav.icloud.com.evil.test'), [], hosts)).toBe(false);
  expect(credentialTarget(new URL('http://calendar.test:8080'), ['http://calendar.test:8080'], [])).toBe(true);
  expect(credentialTarget(new URL('http://calendar.test:8081'), ['http://calendar.test:8080'], [])).toBe(false);
});
