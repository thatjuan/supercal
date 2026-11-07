import { test, expect, afterAll } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { guardedRequest, normalizeUrl, isPublicIp, resolveTarget } from '../src/ssrf';
import { syncIcs } from '../src/ics';
import { recurringIcs, allDayIcs } from '../src/fixtures';
let calls = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  calls++;
  const url = new URL(req.url);
  if (url.pathname === '/redirect-private') return Response.redirect('http://169.254.169.254/latest/meta-data/');
  if (url.pathname === '/loop') return Response.redirect('/loop');
  if (url.pathname === '/redirect') return Response.redirect('/feed');
  if (url.pathname === '/slow') { await Bun.sleep(200); return new Response('late'); }
  if (url.pathname === '/bomb') return new Response(gzipSync('x'.repeat(50000)), { headers: { 'Content-Encoding': 'gzip' } });
  if (url.pathname === '/host') return new Response(req.headers.get('host'));
  if (url.pathname === '/bad') return new Response('<html>oops</html>', { headers: { 'Content-Type': 'text/calendar' } });
  if (url.pathname === '/empty') return new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
  if (req.headers.get('if-none-match') === '"v1"' || req.headers.get('if-modified-since') === 'Sat, 07 Nov 2026 00:00:00 GMT') return new Response(null, { status: 304 });
  return new Response(gzipSync(recurringIcs), { headers: { ETag: '"v1"', 'Last-Modified': 'Sat, 07 Nov 2026 00:00:00 GMT', 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' } });
} });
const origin = `http://calendar.test:${server.port}`;
const options = { resolve: async () => [{ address: '127.0.0.1', family: 4 }], allow: [{ origin, cidrs: ['127.0.0.1/32'] }] };
afterAll(() => server.stop(true));
for (const ip of ['127.0.0.1','127.255.255.255','0.0.0.0','10.1.2.3','172.16.0.1','172.31.255.255','192.168.0.1','169.254.169.254','100.64.0.1','100.127.255.255','224.0.0.1','240.0.0.1','::','::1','fc00::1','fd00::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:192.168.1.1','64:ff9b::a00:1','2001:db8::1']) {
  test(`blocks ${ip}`, () => expect(isPublicIp(ip)).toBe(false));
}
test('public address examples', () => { expect(isPublicIp('1.1.1.1')).toBe(true); expect(isPublicIp('2606:4700:4700::1111')).toBe(true); });
test('URL normalization blocks numeric IPv4 tricks', async () => {
  for (const input of ['http://2130706433','http://0x7f000001','http://0177.0.0.1','http://[::ffff:127.0.0.1]']) await expect(resolveTarget(normalizeUrl(input), {}, AbortSignal.timeout(1000))).rejects.toThrow('Blocked');
  expect(normalizeUrl('webcal://example.com/a').href).toBe('https://example.com/a');
  expect(() => normalizeUrl('file:///etc/passwd')).toThrow(); expect(() => normalizeUrl('http://user:pass@example.com')).toThrow();
});
test('mixed public/private DNS answer rejected', async () => {
  await expect(resolveTarget(new URL('http://calendar.test'), { resolve: async () => [{ address: '1.1.1.1', family: 4 },{ address:'127.0.0.1', family:4 }] }, AbortSignal.timeout(1000))).rejects.toThrow('Blocked');
});
test('LAN rejected without operator allowlist; exact origin+CIDR permits it and Host survives IP dial', async () => {
  await expect(guardedRequest(origin + '/host', {}, { resolve: options.resolve })).rejects.toThrow('Blocked');
  const r = await guardedRequest(origin + '/host', {}, options); expect(r.text).toBe(`calendar.test:${server.port}`); expect(r.address).toBe('127.0.0.1');
  await expect(guardedRequest(origin + '/host', {}, { ...options, allow: [{ origin, cidrs: ['192.168.0.0/16'] }] })).rejects.toThrow('Blocked');
});
test('pinning uses one DNS answer without resolving the name at connect time', async () => {
  let lookups = 0; const r = await guardedRequest(origin + '/host', {}, { ...options, resolve: async () => { lookups++; return [{ address: lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }]; } });
  expect(lookups).toBe(1); expect(r.text).toBe(`calendar.test:${server.port}`);
});
test('redirect rechecks DNS and rejects metadata before connection', async () => {
  const before = calls; await expect(guardedRequest(origin + '/redirect-private', {}, options)).rejects.toThrow('Blocked'); expect(calls - before).toBe(1);
  let lookups = 0;
  await expect(guardedRequest(origin + '/redirect', {}, { ...options, resolve: async () => [{ address: ++lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }] })).rejects.toThrow('Blocked'); expect(lookups).toBe(2);
});
test('redirect count, deadline and decompressed body bounds', async () => {
  await expect(guardedRequest(origin + '/loop', {}, { ...options, maxRedirects: 2 })).rejects.toThrow('Redirect limit');
  await expect(guardedRequest(origin + '/slow', {}, { ...options, timeoutMs: 30 })).rejects.toThrow();
  await expect(guardedRequest(origin + '/bomb', {}, { ...options, maxBytes: 1000 })).rejects.toThrow('Body too large');
  await expect(guardedRequest(origin, {}, { ...options, timeoutMs: 20, resolve: async () => { await Bun.sleep(100); return []; } })).rejects.toThrow();
});
test('gzip + sloppy MIME + redirect + conditional GET preserve recurrence', async () => {
  const first = await syncIcs(origin + '/redirect', undefined, options); expect(first.upserts).toHaveLength(1); expect(first.upserts[0]?.ical).toContain('RECURRENCE-ID');
  const second = await syncIcs(origin + '/feed', first.nextCursor, options); expect(second.upserts).toHaveLength(0); expect(second.nextCursor).toBe(first.nextCursor);
  const modifiedSince = await syncIcs(origin + '/feed', { ...first.nextCursor, etag: undefined }, options); expect(modifiedSince.upserts).toHaveLength(0);
  const empty = await syncIcs(origin + '/empty', first.nextCursor, options); expect(empty.deletes).toEqual(['astrolabe-recurring']);
  await expect(syncIcs(origin + '/bad', first.nextCursor, options)).rejects.toThrow('Not an iCalendar');
});
test('ambient proxy is rejected before network access in Bun 1.3.4', async () => {
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('PROXY_USED')});
  try {
    const child = Bun.spawn([process.execPath,'-e',`import {guardedRequest} from './src/ssrf.ts'; const origin=process.env.FIXTURE_ORIGIN!; const r=await guardedRequest(origin+'/host',{}, {allow:[{origin,cidrs:['127.0.0.1/32']}],resolve:async()=>[{address:'127.0.0.1',family:4}]}); console.log(r.text);`], {cwd:new URL('..',import.meta.url).pathname, env:{PATH:process.env.PATH,FIXTURE_ORIGIN:origin,HTTP_PROXY:proxy.url.href,HTTPS_PROXY:proxy.url.href,ALL_PROXY:proxy.url.href,NO_PROXY:''},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).not.toBe(0); expect(await new Response(child.stderr).text()).toContain('proxy-free worker');
  } finally {proxy.stop(true);}
});
