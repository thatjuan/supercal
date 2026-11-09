/**
 * The CalDAV server over a seeded scratch database (see `fixture.ts`): discovery, every property
 * of architecture §9 and every report as whitespace-normalised golden XML, sync-token rules,
 * listing cost, UID separation between collections, and credential rotation.
 */
import { closeDb, connectDb, migrate, systemSetting, withTenant, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { createDatabase, unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { createConnection, type Socket } from 'node:net';
import { idleBus } from '../../src/bus.ts';
import { createDav } from '../../src/dav/index.ts';
import { createFeedService } from '../../src/feeds/service.ts';
import { testSecrets } from '../auth-fixture.ts';
import { DEVICE, seedHosted } from './hosted-fixture.ts';
import { ALICE, BOB, BULK_SIZE, aliceFeedId, bumpPublicationEpoch, deleteEvent, putEvent, seed } from './fixture.ts';

const HOST = 'https://cal.example.test';
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let app: ReturnType<typeof createDav>;
let password: string = ALICE.password;

const auth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function dav(method: string, path: string, { body, depth, user = ALICE.username, pass = password, headers = {} }: { body?: string; depth?: string; user?: string; pass?: string; headers?: Record<string, string> } = {}) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: auth(user, pass), ...(depth !== undefined && { Depth: depth }), ...headers },
    ...(body !== undefined && { body }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** Golden form: no XML declaration or namespace declarations, generated ids and hashes replaced. */
const normalise = (xml: string) =>
  xml
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .replace(/ xmlns:[a-z0-9]+="[^"]*"/g, '')
    .replace(/pub_[a-z0-9]+/g, 'pub_ID')
    .replace(/[A-Za-z0-9_-]{22}\.ics/g, 'HREF.ics')
    .replace(/&quot;[A-Za-z0-9_-]{27}&quot;/g, '&quot;ETAG&quot;')
    .replace(/>\s+</g, '><')
    .trim();

const propfind = (...props: string[]) =>
  `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props.map((p) => `<${p}/>`).join('')}</d:prop></d:propfind>`;

/** The hrefs and statuses of a multistatus, in order. */
const responses = (xml: string) =>
  [...xml.matchAll(/<d:response><d:href>([^<]*)<\/d:href>([\s\S]*?)<\/d:response>/g)].map(([, href, rest]) => ({
    href: href ?? '',
    status: /HTTP\/1.1 (\d+)/.exec(rest ?? '')?.[1],
    etag: /<d:getetag>([^<]*)</.exec(rest ?? '')?.[1],
    uid: /UID:([^\r\n]*)/.exec(rest ?? '')?.[1],
    summary: /SUMMARY:([^\r\n]*)/.exec(rest ?? '')?.[1],
  }));
const tokenOf = (xml: string) => /<d:sync-token>([^<]*)</.exec(xml)?.[1] ?? '';
const syncBody = (token: string, extra = '') =>
  `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level>${extra}<d:prop><d:getetag/></d:prop></d:sync-collection>`;

const WORK = `/dav/${ALICE.username}/cal/work/`;
const MERGED = `/dav/${ALICE.username}/cal/merged/`;

describe.skipIf(!testDatabaseUrl)('CalDAV server', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('dav');
    await migrate(scratch.url);
    connectDb(scratch.url);
    await seed();
    await seedHosted();
    app = createDav({ secrets: testSecrets, bus: idleBus, publicUrl: HOST });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await scratch?.drop();
  });

  describe('discovery and protocol', () => {
    test('/.well-known/caldav redirects to /dav/ without auth', async () => {
      const res = await app.request('/.well-known/caldav', { method: 'PROPFIND' });
      expect([res.status, res.headers.get('location')]).toEqual([301, '/dav/']);
    });

    test('OPTIONS advertises DAV classes and the read verbs', async () => {
      const res = await app.request('/dav/', { method: 'OPTIONS' });
      expect([res.status, res.headers.get('dav'), res.headers.get('allow')]).toEqual([200, '1, 3, calendar-access', 'OPTIONS, PROPFIND, REPORT, GET, HEAD']);
    });

    test('PROPFIND on / and /dav/ answers current-user-principal', async () => {
      for (const path of ['/', '/dav/']) {
        const res = await dav('PROPFIND', path, { depth: '0', body: propfind('d:current-user-principal') });
        expect(res.status).toBe(207);
        expect(res.headers.get('dav')).toBe('1, 3, calendar-access');
        expect(res.text).toContain(`<d:current-user-principal><d:href>/dav/${ALICE.username}/</d:href></d:current-user-principal>`);
      }
    });

    test('requests need a valid login', async () => {
      const none = await app.request('/dav/', { method: 'PROPFIND' });
      expect([none.status, none.headers.get('www-authenticate')]).toEqual([401, 'Basic realm="Supercal", charset="UTF-8"']);
      expect((await dav('PROPFIND', '/dav/', { pass: 'wrong' })).status).toBe(401);
    });

    test("another login's principal is 403", async () => {
      expect((await dav('PROPFIND', `/dav/${BOB.username}/`, { depth: '0' })).status).toBe(403);
      expect((await dav('PROPFIND', `/dav/${BOB.username}/`, { depth: '0', user: BOB.username, pass: BOB.password })).status).toBe(207);
    });

    test('Depth: infinity is refused with propfind-finite-depth', async () => {
      const res = await dav('PROPFIND', WORK, { depth: 'infinity' });
      expect([res.status, normalise(res.text)]).toEqual([403, '<d:error><d:propfind-finite-depth/></d:error>']);
    });

    test('every write verb is 403 need-privileges', async () => {
      for (const method of ['PUT', 'DELETE', 'PROPPATCH', 'MKCALENDAR', 'MOVE', 'COPY', 'LOCK']) {
        const res = await dav(method, `${WORK}x.ics`, { body: 'x' });
        expect([method, res.status, normalise(res.text)]).toEqual([method, 403, '<d:error><d:need-privileges/></d:error>']);
      }
    });

    test('the home lists only enabled publications, in sort order', async () => {
      const res = await dav('PROPFIND', `/dav/${ALICE.username}/cal/`, { depth: '1', body: propfind('d:resourcetype') });
      expect(responses(res.text).map((r) => r.href)).toEqual(['', 'work/', 'merged/', 'busy/', 'bulk/'].map((s) => `/dav/${ALICE.username}/cal/${s}`));
      expect((await dav('PROPFIND', `/dav/${ALICE.username}/cal/hidden/`, { depth: '0' })).status).toBe(404);
    });
  });

  describe('request bounds', () => {
    test('20 concurrent device requests finish through the default pool of 10', async () => {
      const options = { user: DEVICE.username, pass: DEVICE.password, body: propfind('d:current-user-principal') };
      expect((await dav('PROPFIND', '/dav/', options)).status).toBe(207);
      const results = await Promise.all(Array.from({ length: 20 }, () => dav('PROPFIND', '/dav/', options)));
      expect(results.map((res) => res.status)).toEqual(Array(20).fill(207));
      expect((await dav('PROPFIND', '/dav/', { user: BOB.username, pass: BOB.password })).status).toBe(207);
    });

    test('ten unfinished PROPFIND uploads hold no transaction and another tenant can read', async () => {
      if (!scratch) throw new Error('scratch database missing');
      // Warm the feed credential cache, so the only remaining work is reading the body.
      expect((await dav('PROPFIND', '/dav/')).status).toBe(207);
      const monitor = createDatabase(scratch.url, 1);
      let arrived = 0;
      const started = Promise.withResolvers<void>();
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          if (++arrived === 10) started.resolve();
          return app.fetch(req);
        },
      });
      const sockets: Socket[] = [];
      try {
        await Promise.all(Array.from({ length: 10 }, () => new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: server.port ?? 0 }, () => {
            socket.write(`PROPFIND /dav/ HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${auth(ALICE.username, password)}\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n${' '.repeat(64 * 1024)}`);
            resolve();
          });
          socket.on('error', reject);
          socket.resume();
          sockets.push(socket);
        })));
        await started.promise;
        // Let cached authentication and transaction setup run while all uploads remain open.
        await Bun.sleep(100);
        const rows = await monitor.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`);
        expect(rows[0]?.count).toBe(0);
        const other = await fetch(`http://127.0.0.1:${server.port}/dav/`, {
          method: 'PROPFIND', headers: { Authorization: auth(BOB.username, BOB.password), Connection: 'close' }, signal: AbortSignal.timeout(2000),
        });
        expect(other.status).toBe(207);
        await other.text();
      } finally {
        // Complete uploads only after the assertions, so Bun can settle the pending body reads.
        await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.once('data', () => socket.destroy());
          const xml = propfind('d:current-user-principal');
          socket.write(xml + ' '.repeat(1048576 - 64 * 1024 - xml.length));
        })));
        await server.stop(true);
        await monitor.$client.end();
      }
    });

    test('DAV and root discovery bodies are capped at 2 MiB', async () => {
      for (const path of ['/', '/dav', '/dav/']) {
        const res = await dav('PROPFIND', path, { body: 'x'.repeat(2 * 1024 * 1024 + 1) });
        expect(res.status).toBe(413);
      }
    });
  });

  describe('properties (golden XML)', () => {
    const principal = `/dav/${ALICE.username}/`;
    const one = async (path: string, prop: string) => normalise((await dav('PROPFIND', path, { depth: '0', body: propfind(prop) })).text);

    test('current-user-principal', async () => {
      expect(await one(principal, 'd:current-user-principal')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/alice-dav/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('principal-URL', async () => {
      expect(await one(principal, 'd:principal-URL')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/</d:href><d:propstat><d:prop><d:principal-URL><d:href>/dav/alice-dav/</d:href></d:principal-URL></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('calendar-home-set', async () => {
      expect(await one(principal, 'c:calendar-home-set')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/dav/alice-dav/cal/</d:href></cal:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('calendar-user-address-set is the owner email', async () => {
      expect(await one(principal, 'c:calendar-user-address-set')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/</d:href><d:propstat><d:prop><cal:calendar-user-address-set><d:href>mailto:alice@example.com</d:href></cal:calendar-user-address-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('displayname', async () => {
      expect(await one(WORK, 'd:displayname')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('resourcetype', async () => {
      expect(await one(WORK, 'd:resourcetype')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('calendar-color is #RRGGBBAA', async () => {
      expect(await one(WORK, 'a:calendar-color')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><ical:calendar-color>#336699FF</ical:calendar-color></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('calendar-order is sort_order', async () => {
      expect(await one(MERGED, 'a:calendar-order')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/merged/</d:href><d:propstat><d:prop><ical:calendar-order>1</ical:calendar-order></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('getctag and sync-token are the same token', async () => {
      expect(await one(WORK, 'cs:getctag')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><cs:getctag>https://cal.example.test/ns/sync/pub_ID/0/4</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
      expect(await one(WORK, 'd:sync-token')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:sync-token>https://cal.example.test/ns/sync/pub_ID/0/4</d:sync-token></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('supported-calendar-component-set', async () => {
      expect(await one(WORK, 'c:supported-calendar-component-set')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('supported-report-set', async () => {
      expect(await one(WORK, 'd:supported-report-set')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:supported-report-set><d:supported-report><d:report><cal:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><cal:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('current-user-privilege-set is read only', async () => {
      expect(await one(WORK, 'd:current-user-privilege-set')).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });
    test('unknown properties go in a 404 propstat', async () => {
      expect(normalise((await dav('PROPFIND', WORK, { depth: '0', body: propfind('d:displayname', 'x:nope xmlns:x="urn:x"') })).text)).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><x0:nope/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>"`);
    });
  });

  describe('listing and objects', () => {
    test('Depth 1 lists objects with ETags and no calendar data', async () => {
      const res = await dav('PROPFIND', WORK, { depth: '1', body: propfind('d:getetag', 'c:calendar-data') });
      expect(normalise(res.text)).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/</d:href><d:propstat><d:prop><d:getetag/><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><cal:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>"`);
    });

    test(`Depth 1 over ${BULK_SIZE} objects takes under 150 ms, with the object index not yet cached`, async () => {
      await dav('PROPFIND', '/dav/', { depth: '0' }); // the login's argon2 verification is not what is measured
      const started = performance.now();
      const res = await dav('PROPFIND', `/dav/${ALICE.username}/cal/bulk/`, { depth: '1', body: propfind('d:getetag') });
      const elapsed = performance.now() - started;
      expect(responses(res.text)).toHaveLength(BULK_SIZE + 1);
      expect(elapsed).toBeLessThan(150);
    });

    test('GET serves one VCALENDAR with its ETag; If-None-Match gives 304; HEAD has no body', async () => {
      const [entry] = responses((await dav('PROPFIND', WORK, { depth: '1', body: propfind('d:getetag') })).text).filter((r) => r.etag);
      if (!entry?.etag) throw new Error('no object listed');
      const etag = entry.etag.replaceAll('&quot;', '"');
      const got = await dav('GET', entry.href);
      expect([got.status, got.headers.get('etag'), got.text.match(/BEGIN:VCALENDAR/g)?.length]).toEqual([200, etag, 1]);
      expect((await dav('GET', entry.href, { headers: { 'If-None-Match': etag } })).status).toBe(304);
      const head = await dav('HEAD', entry.href);
      expect([head.status, head.text]).toEqual([200, '']);
      expect((await dav('GET', `${WORK}unknown.ics`)).status).toBe(404);
    });

    test('a recurring series keeps its override; an all-day event stays a date', async () => {
      const res = await dav('REPORT', WORK, {
        body: `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`,
      });
      expect(res.text).toContain('RECURRENCE-ID:20261109T100000Z');
      expect(res.text).toContain('DTSTART;VALUE=DATE:20261224');
    });

    test('the same source UID gets different UIDs in a passthrough and a virtual collection', async () => {
      const uids = async (path: string) => {
        const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261112T000000Z" end="20261113T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
        return responses((await dav('REPORT', path, { body })).text).flatMap((r) => (r.summary === 'Shared meeting' ? [r.uid] : []));
      };
      const [work, merged] = [await uids(WORK), await uids(MERGED)];
      expect(work).toEqual(['meeting@example.com']);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatch(/@supercal$/);
    });
  });

  describe('reports (golden XML)', () => {
    test('calendar-query with a time-range uses the coarse span', async () => {
      const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261220T000000Z" end="20261231T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
      expect(normalise((await dav('REPORT', WORK, { body })).text)).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"`);
    });

    test('calendar-query on another component is empty', async () => {
      const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>`;
      expect(normalise((await dav('REPORT', WORK, { body })).text)).toBe('<d:multistatus></d:multistatus>');
    });

    test('calendar-multiget deduplicates repeated hrefs and alternate spellings', async () => {
      const first = responses((await dav('PROPFIND', WORK, { depth: '1', body: propfind('d:getetag') })).text).find((r) => r.etag);
      if (!first) throw new Error('object missing');
      for (const hrefs of [Array<string>(16).fill(first.href), [first.href, HOST + first.href]]) {
        const body = `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>${hrefs.map((href) => `<d:href>${href}</d:href>`).join('')}</c:calendar-multiget>`;
        const res = await dav('REPORT', WORK, { body });
        expect(res.status).toBe(207);
        expect(responses(res.text)).toHaveLength(1);
        expect(res.text.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
      }
    });

    test('calendar-multiget rejects 1,001 hrefs before deduplication', async () => {
      const body = `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${'<d:href>missing.ics</d:href>'.repeat(1001)}</c:calendar-multiget>`;
      const res = await dav('REPORT', WORK, { body });
      expect([res.status, normalise(res.text)]).toEqual([403, '<d:error><d:number-of-matches-within-limits/></d:error>']);
    });

    test('calendar-multiget renders known hrefs and 404s unknown ones', async () => {
      const [first] = responses((await dav('PROPFIND', `/dav/${ALICE.username}/cal/busy/`, { depth: '1', body: propfind('d:getetag') })).text).filter((r) => r.etag);
      const body = `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${first?.href}</d:href><d:href>/dav/${ALICE.username}/cal/busy/nope.ics</d:href></c:calendar-multiget>`;
      const text = (await dav('REPORT', `/dav/${ALICE.username}/cal/busy/`, { body })).text;
      expect(normalise(text).replace(/UID:[^&\r\n]*@supercal/, 'UID:OUT@supercal')).toMatchInlineSnapshot(`
        "<d:multistatus><d:response><d:href>/dav/alice-dav/cal/busy/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag><cal:calendar-data>BEGIN:VCALENDAR
        PRODID:-//Supercal//EN
        VERSION:2.0
        BEGIN:VEVENT
        UID:OUT@supercal
        DTSTART:20261118T080000Z
        DURATION:PT1H
        DTSTAMP:19700101T000000Z
        SUMMARY:Busy
        END:VEVENT
        END:VCALENDAR
        </cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/busy/nope.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>"
      `);
    });

    test('sync-collection: initial, then incremental update, delete and add', async () => {
      const initial = await dav('REPORT', WORK, { body: syncBody('') });
      expect(normalise(initial.text)).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:sync-token>https://cal.example.test/ns/sync/pub_ID/0/4</d:sync-token></d:multistatus>"`);
      await putEvent('work', 'allday@example.com', 'Holidays (edited)');
      await deleteEvent('work', 'floating@example.com');
      await putEvent('work', 'new@example.com', 'Brand new');
      const next = await dav('REPORT', WORK, { body: syncBody(tokenOf(initial.text)) });
      expect(normalise(next.text)).toMatchInlineSnapshot(`"<d:multistatus><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response><d:response><d:href>/dav/alice-dav/cal/work/HREF.ics</d:href><d:propstat><d:prop><d:getetag>&quot;ETAG&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:sync-token>https://cal.example.test/ns/sync/pub_ID/0/5011</d:sync-token></d:multistatus>"`);
    });

    test('sync-collection: in a virtual publication a UID alive in another source is not deleted', async () => {
      const before = tokenOf((await dav('REPORT', MERGED, { body: syncBody('') })).text);
      await deleteEvent('home', 'meeting@example.com');
      const one = await dav('REPORT', MERGED, { body: syncBody(before) });
      expect(responses(one.text).map((r) => r.status)).toEqual(['200']);
      await deleteEvent('work', 'meeting@example.com');
      const both = await dav('REPORT', MERGED, { body: syncBody(tokenOf(one.text)) });
      expect(responses(both.text).map((r) => r.status)).toEqual(['404']);
      await putEvent('work', 'meeting@example.com', 'Shared meeting', '20261112T120000Z');
      await putEvent('home', 'meeting@example.com', 'Shared meeting', '20261112T120000Z');
    });

    test('sync-collection: <d:limit> truncates and answers 507 for the collection', async () => {
      const first = await dav('REPORT', WORK, { body: syncBody('', '<d:limit><d:nresults>2</d:nresults></d:limit>') });
      const page = responses(first.text);
      expect(page.map((r) => r.status)).toEqual(['200', '200', '507']);
      expect(page.at(-1)?.href).toBe(WORK);
      const rest = await dav('REPORT', WORK, { body: syncBody(tokenOf(first.text)) });
      expect(responses(rest.text).length).toBeGreaterThan(0);
      expect(responses(rest.text).some((r) => r.status === '507')).toBe(false);
    });

    test('sync-collection: foreign, malformed, old-epoch and purged tokens get 403 valid-sync-token', async () => {
      const token = tokenOf((await dav('REPORT', WORK, { body: syncBody('') })).text);
      const merged = tokenOf((await dav('REPORT', MERGED, { body: syncBody('') })).text);
      const invalid = async (t: string) => {
        const res = await dav('REPORT', WORK, { body: syncBody(t) });
        return [res.status, normalise(res.text)];
      };
      const refused = [403, '<d:error><d:valid-sync-token/></d:error>'];
      expect(await invalid('garbage')).toEqual(refused);
      expect(await invalid(merged)).toEqual(refused);

      const db = unsafeDb();
      await db.update(systemSetting).set({ value: sql`to_jsonb(${Number(token.split('/').at(-1)) + 1}::bigint)` }).where(eq(systemSetting.key, 'tombstone_floor'));
      expect(await invalid(token)).toEqual(refused);
      await db.update(systemSetting).set({ value: sql`to_jsonb(0::bigint)` }).where(eq(systemSetting.key, 'tombstone_floor'));

      expect((await dav('REPORT', WORK, { body: syncBody(token) })).status).toBe(207);
      await bumpPublicationEpoch('work');
      expect(await invalid(token)).toEqual(refused);
    });

    test('calendar-multiget caps the accumulated XML response at 32 MiB', async () => {
      const uids = Array.from({ length: 20 }, (_, i) => `multiget-bytes-${i}`);
      try {
        // XML escaping expands these otherwise modest calendar objects beyond the response cap.
        for (const uid of uids) await putEvent('work', uid, '&'.repeat(350_000));
        const hrefs = responses((await dav('PROPFIND', WORK, { depth: '1', body: propfind('d:getetag') })).text).filter((r) => r.etag).map((r) => r.href);
        const body = `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>${hrefs.map((href) => `<d:href>${href}</d:href>`).join('')}</c:calendar-multiget>`;
        const res = await dav('REPORT', WORK, { body });
        expect([res.status, normalise(res.text)]).toEqual([403, '<d:error><d:number-of-matches-within-limits/></d:error>']);
      } finally {
        for (const uid of uids) await deleteEvent('work', uid);
      }
    }, 30_000);
  });

  test('rotating the password makes the old one fail at once on the same process', async () => {
    expect((await dav('PROPFIND', '/dav/', { depth: '0' })).status).toBe(207);
    const feedId = await aliceFeedId();
    const tenantId = 'org_dav_alice' as TenantId;
    const principal = { kind: 'user', userId: 'user_dav_alice', tenantId, role: 'owner', via: 'session', isOperator: false } as const;
    const rotated = await withTenant(tenantId, (tx) => createFeedService(testSecrets).rotateCaldavPassword(tx, principal, feedId));
    expect((await dav('PROPFIND', '/dav/', { depth: '0' })).status).toBe(401);
    password = rotated.password;
    expect((await dav('PROPFIND', '/dav/', { depth: '0' })).status).toBe(207);
  });
});
