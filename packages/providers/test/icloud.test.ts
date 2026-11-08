/**
 * The iCloud preset over the real guarded transport and a local server answering for several
 * hosts: Basic credentials follow a redirect into a partition host (`p42-caldav.icloud.com`) and
 * are stripped on a redirect anywhere else.
 */
import { afterAll, expect, test } from 'bun:test';
import { AuthFailedError, createCaldavAdapter, createGuardedFetch, icloudLogin, type ProviderCredentials } from '../src/index.ts';
import { collect, davContext, DavFixture, event } from './dav-fixture.ts';

const credentials: ProviderCredentials = { provider: 'icloud', appleId: 'me@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' };
const expected = `Basic ${btoa('me@icloud.com:abcd-efgh-ijkl-mnop')}`;
const dav = new DavFixture().collection('/u/cals/home/', { name: 'Home' });
dav.put('/u/cals/home/a.ics', event('a'));

let redirectTo = 'p42-caldav.icloud.com';
const seen: { host: string; authorization: string | null }[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get('host')?.split(':')[0] ?? '';
    seen.push({ host, authorization: req.headers.get('authorization') });
    if (host === 'caldav.icloud.com') return new Response(null, { status: 301, headers: { location: `http://${redirectTo}:${url.port}${url.pathname}` } });
    if (req.headers.get('authorization') !== expected) return new Response('no', { status: 401, headers: { 'www-authenticate': 'Basic realm="iCloud"' } });
    const reply = dav.handle(req.method, url, req.headers.get('depth'), await req.text());
    return new Response(reply.body, { status: reply.status, headers: reply.headers ?? {} });
  },
});
afterAll(() => server.stop(true));

const port = server.port;
const origins = ['caldav.icloud.com', 'p42-caldav.icloud.com', 'evil.example'].map((host) => ({ origin: `http://${host}:${port}`, cidrs: ['127.0.0.1/32'] }));
const guarded = createGuardedFetch({ allow: origins }, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
const icloud = createCaldavAdapter('icloud', (c) => icloudLogin(c, `http://caldav.icloud.com:${port}/`));

test('credentials survive a redirect into an iCloud partition host, and sync runs there', async () => {
  seen.length = 0;
  const ctx = davContext(guarded, credentials);
  const [calendar] = await icloud.listCalendars(ctx);
  expect(calendar?.providerCalendarId).toBe(`http://p42-caldav.icloud.com:${port}/u/cals/home/`);
  expect(seen.filter((s) => s.host === 'p42-caldav.icloud.com').every((s) => s.authorization === expected)).toBe(true);
  if (!calendar) throw new Error('no calendar');
  const items = await collect(icloud.sync(ctx, { id: 'cal_1', providerCalendarId: calendar.providerCalendarId, capabilities: calendar.capabilities }, null));
  expect(items.flatMap((i) => (i.kind === 'page' ? i.upserts.map((o) => o.groupUid) : []))).toEqual(['a']);
});

test('credentials are stripped on a redirect to another host', async () => {
  seen.length = 0;
  redirectTo = 'evil.example';
  await expect(icloud.listCalendars(davContext(guarded, credentials))).rejects.toBeInstanceOf(AuthFailedError);
  const evil = seen.filter((s) => s.host === 'evil.example');
  expect(evil.length).toBeGreaterThan(0);
  expect(evil.every((s) => s.authorization === null)).toBe(true);
});
