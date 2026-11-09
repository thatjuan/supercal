/**
 * The CalDAV adapter (tsdav over a scripted guarded transport): discovery, both incremental modes
 * and the failure rules, where an error must never yield a cursor or a deletion.
 */
import { groupUidsOf } from '@supercal/core';
import { createDavSession, DavStatusError, type DavSession } from '../src/caldav/session.ts';
import { syncCollection } from '../src/caldav/sync.ts';
import { createGuardedFetch, credentialTarget, type GuardedRequest } from '../src/transport/index.ts';
import { icloudLogin } from '../src/caldav/index.ts';
import { describe, expect, spyOn, test } from 'bun:test';
import { AuthFailedError, caldavAdapter, ProviderUnavailableError, UnsupportedAuthError, type SourceCalendarRef, type SyncEnd, type SyncPage } from '../src/index.ts';
import type { CaldavCursor } from '../src/caldav/index.ts';
import { collect, davContext, DavFixture, event } from './dav-fixture.ts';

const WORK = '/u/cals/work/';
const ref = (incremental: 'sync-collection' | 'etag'): SourceCalendarRef => ({ id: 'cal_1', providerCalendarId: `https://dav.test${WORK}`, capabilities: { incremental, push: false } });

function setup({ sync = true } = {}) {
  const server = new DavFixture().collection(WORK, { name: 'Work', color: '#48aaffff', sync });
  server.put(`${WORK}a.ics`, event('a')).put(`${WORK}b.ics`, event('b'));
  return { server, ctx: davContext(server.asGuardedFetch()) };
}

type Item = SyncPage | SyncEnd<CaldavCursor>;
async function run(ctx: ReturnType<typeof davContext>, incremental: 'sync-collection' | 'etag', cursor: CaldavCursor | null) {
  const items: Item[] = await collect(caldavAdapter.sync(ctx, ref(incremental), cursor));
  const end = items.at(-1);
  if (end?.kind !== 'end') throw new Error('no end item');
  const pages = items.filter((i): i is SyncPage => i.kind === 'page');
  return { end, upserts: pages.flatMap((p) => p.upserts), deletes: pages.flatMap((p) => p.deletes), pages };
}

/** The items a failing sync yielded before it threw, and the error. */
async function failing(ctx: ReturnType<typeof davContext>, incremental: 'sync-collection' | 'etag', cursor: CaldavCursor | null) {
  const items: Item[] = [];
  try {
    for await (const item of caldavAdapter.sync(ctx, ref(incremental), cursor)) items.push(item);
  } catch (error) {
    return { items, error };
  }
  throw new Error('the sync did not fail');
}

describe('discovery', () => {
  test('well-known → principal → home, keeping event calendars with colour, zone and incremental mode', async () => {
    const { server, ctx } = setup();
    server.collection('/u/cals/tasks/', { components: ['VTODO'] }).collection('/u/cals/old/', { name: 'Old', sync: false });
    const calendars = await caldavAdapter.listCalendars(ctx);
    expect(calendars).toEqual([
      { providerCalendarId: `https://dav.test${WORK}`, name: 'Work', color: '#48AAFF', timezone: 'Europe/Berlin', capabilities: { incremental: 'sync-collection', push: false } },
      { providerCalendarId: 'https://dav.test/u/cals/old/', name: 'Old', color: null, timezone: 'Europe/Berlin', capabilities: { incremental: 'etag', push: false } },
    ]);
    expect(server.requests.slice(0, 3)).toEqual(['PROPFIND /.well-known/caldav', 'PROPFIND /u/', 'PROPFIND /u/cals/']);
  });

  test('a 401 is AuthFailedError; a Digest-only challenge is UnsupportedAuthError', async () => {
    const { server, ctx } = setup();
    server.quirks.status = 401;
    server.quirks.challenge = 'Basic realm="dav"';
    const basic = await caldavAdapter.listCalendars(ctx).catch((e: unknown) => e);
    expect(basic).toBeInstanceOf(AuthFailedError);
    expect(basic).not.toBeInstanceOf(UnsupportedAuthError);
    server.quirks.challenge = 'Digest realm="dav", nonce="x"';
    await expect(caldavAdapter.listCalendars(ctx)).rejects.toBeInstanceOf(UnsupportedAuthError);
  });

  test('credentials are never sent to a host outside the account', async () => {
    const { ctx } = setup();
    const sent: string[] = [];
    const inner = ctx.fetch;
    ctx.fetch = async (req) => (sent.push(new URL(req.url).host), inner(req));
    const foreign = { ...ref('etag'), providerCalendarId: 'https://evil.test/u/cals/work/' };
    await expect(collect(caldavAdapter.sync(ctx, foreign, null))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(sent).toEqual([]);
  });
});

describe('sync-collection', () => {
  test('no token is a snapshot; a token is a delta where 404s are deletes, and only end carries the token', async () => {
    const { server, ctx } = setup();
    const first = await run(ctx, 'sync-collection', null);
    expect(first.end.mode).toBe('snapshot');
    expect(first.upserts.map((o) => [o.id, o.groupUid])).toEqual([
      [`${WORK}a.ics`, 'a'],
      [`${WORK}b.ics`, 'b'],
    ]);
    expect(first.upserts[0]?.payload).toContain('UID:a');

    server.put(`${WORK}a.ics`, event('a')).remove(`${WORK}b.ics`).put(`${WORK}c.ics`, event('c'));
    const delta = await run(ctx, 'sync-collection', first.end.cursor);
    expect(delta.end.mode).toBe('delta');
    expect(delta.upserts.map((o) => o.id).sort()).toEqual([`${WORK}a.ics`, `${WORK}c.ics`]);
    expect(delta.deletes).toEqual([`${WORK}b.ics`]);
    expect(delta.end.cursor).toMatchObject({ mode: 'sync', token: `tok-${server.version}` });
  });

  test('a truncated answer (507 on the collection) continues with the returned token in the same run', async () => {
    const { server, ctx } = setup();
    server.put(`${WORK}c.ics`, event('c'));
    server.quirks.truncateAfter = 2;
    const { end, upserts } = await run(ctx, 'sync-collection', null);
    expect(upserts.map((o) => o.groupUid).sort()).toEqual(['a', 'b', 'c']);
    expect(server.requests.filter((r) => r.endsWith('sync-collection'))).toHaveLength(2);
    expect(end).toMatchObject({ mode: 'snapshot', cursor: { token: `tok-${server.version}` } });
  });

  test('an invalid token restarts as a snapshot', async () => {
    const { ctx } = setup();
    const { end, upserts } = await run(ctx, 'sync-collection', { v: 1, mode: 'sync', token: 'expired', split: {} });
    expect(end.mode).toBe('snapshot');
    expect(upserts).toHaveLength(2);
  });

  test('a 501 to sync-collection downgrades to etag mode for good, and an absent ctag never skips the listing', async () => {
    const { server, ctx } = setup({ sync: false });
    server.quirks.noCtag = true;
    const first = await run(ctx, 'sync-collection', null);
    expect(first.end).toMatchObject({ mode: 'snapshot', cursor: { mode: 'etag', ctag: null } });
    expect(first.upserts).toHaveLength(2);
    const again = await run(ctx, 'sync-collection', first.end.cursor);
    expect(again.end.mode).toBe('delta');
    expect(again.upserts).toEqual([]);
    expect(server.requests.filter((r) => r.endsWith('sync-collection'))).toHaveLength(1);
    expect(server.requests.filter((r) => r === `PROPFIND ${WORK}`)).toHaveLength(4);
  });

  test('changed objects are multigot in batches of 100', async () => {
    const { server, ctx } = setup();
    for (let i = 0; i < 148; i++) server.put(`${WORK}n${i}.ics`, event(`n${i}`));
    const { pages, upserts } = await run(ctx, 'sync-collection', null);
    expect(pages.map((p) => p.upserts.length)).toEqual([100, 50]);
    expect(upserts).toHaveLength(150);
  });
});

describe('etag fallback', () => {
  test('an unchanged ctag ends at once; a changed one diffs the etag map and deletes missing hrefs', async () => {
    const { server, ctx } = setup();
    const first = await run(ctx, 'etag', null);
    expect(first.end.mode).toBe('snapshot');
    const before = server.requests.length;
    const idle = await run(ctx, 'etag', first.end.cursor);
    expect(idle).toMatchObject({ upserts: [], deletes: [], end: { mode: 'delta', cursor: first.end.cursor } });
    expect(server.requests.slice(before)).toEqual([`PROPFIND ${WORK}`]);

    server.put(`${WORK}a.ics`, event('a')).remove(`${WORK}b.ics`);
    const delta = await run(ctx, 'etag', first.end.cursor);
    expect(delta.end.mode).toBe('delta');
    expect(delta.upserts.map((o) => o.id)).toEqual([`${WORK}a.ics`]);
    expect(delta.deletes).toEqual([`${WORK}b.ics`]);
  });
});

describe('failure rules', () => {
  test('auth failure on a report is AuthFailedError, never an empty snapshot', async () => {
    const { server, ctx } = setup();
    server.quirks.status = 401;
    const { items, error } = await failing(ctx, 'sync-collection', { v: 1, mode: 'sync', token: 'tok-1', split: {} });
    expect(error).toBeInstanceOf(AuthFailedError);
    expect(items).toEqual([]);
  });

  test('a 403 to sync-collection downgrades, and a 403 on the etag listing is then AuthFailedError', async () => {
    const { server, ctx } = setup();
    server.quirks.syncStatus = 403;
    expect((await run(ctx, 'sync-collection', null)).end.cursor.mode).toBe('etag');
    server.quirks.status = 403;
    expect((await failing(ctx, 'etag', null)).error).toBeInstanceOf(AuthFailedError);
  });

  test('a multiget missing an object throws ProviderUnavailableError before any end', async () => {
    const { server, ctx } = setup();
    server.quirks.dropFromMultiget = new Set([`${WORK}b.ics`]);
    const { items, error } = await failing(ctx, 'sync-collection', null);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(items.some((i) => i.kind === 'end')).toBe(false);
  });

  test('an object that vanished between listing and multiget (404) fails the run, not a deletion', async () => {
    const { server, ctx } = setup();
    const first = await run(ctx, 'etag', null);
    server.put(`${WORK}a.ics`, event('a'));
    const inner = ctx.fetch;
    ctx.fetch = async (req) => {
      if (req.body?.includes('calendar-multiget')) server.remove(`${WORK}a.ics`);
      return inner(req);
    };
    const { items, error } = await failing(ctx, 'etag', first.end.cursor);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(items).toEqual([]);
  });

  test('malformed XML throws ProviderUnavailableError with no items', async () => {
    const { server, ctx } = setup();
    server.quirks.malformed = true;
    const { items, error } = await failing(ctx, 'etag', null);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(items).toEqual([]);
  });
});

test('an object with several UIDs is split into href#uid raw objects, and deleting it deletes each', async () => {
  const { server, ctx } = setup();
  server.put(`${WORK}multi.ics`, event('x', 'y'));
  const first = await run(ctx, 'sync-collection', null);
  expect(first.upserts.filter((o) => o.id.startsWith(`${WORK}multi.ics`)).map((o) => [o.id, o.groupUid])).toEqual([
    [`${WORK}multi.ics#x`, 'x'],
    [`${WORK}multi.ics#y`, 'y'],
  ]);

  server.put(`${WORK}multi.ics`, event('x'));
  const narrowed = await run(ctx, 'sync-collection', first.end.cursor);
  expect(narrowed.upserts.map((o) => o.id)).toEqual([`${WORK}multi.ics`]);
  expect(narrowed.deletes.sort()).toEqual([`${WORK}multi.ics#x`, `${WORK}multi.ics#y`]);

  server.put(`${WORK}multi.ics`, event('x', 'y'));
  const split = await run(ctx, 'sync-collection', narrowed.end.cursor);
  server.remove(`${WORK}multi.ics`);
  const gone = await run(ctx, 'sync-collection', split.end.cursor);
  expect(gone.deletes.sort()).toEqual([`${WORK}multi.ics#x`, `${WORK}multi.ics#y`]);
});

/** A complete XML exchange through tsdav, with a scripted reply body. */
function xmlSession(body: string) {
  const ctx = davContext(async (req) => ({ status: 207, headers: new Headers({ 'content-type': 'application/xml' }), body: new TextEncoder().encode(body), finalUrl: req.url }));
  return createDavSession(ctx, { username: 'u', password: 'p', origins: ['https://dav.test'], hosts: [] });
}
const xmlReply = (children: string, attributes = '') => `<d:multistatus xmlns:d="DAV:" ${attributes}>${children}</d:multistatus>`;
const xmlEntry = (href: string, props = '') => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const padReply = (body: string, bytes: number) => body.replace('</d:multistatus>', `${' '.repeat(Math.max(0, bytes - Buffer.byteLength(body)))}</d:multistatus>`);

const hostileReplies = [
  padReply(xmlReply('<d:x/>'.repeat(10000), Array.from({ length: 1000 }, (_, i) => `xmlns:n${i}="urn:n${i}"`).join(' ')), 159_000),
  padReply(xmlReply(Array.from({ length: 2500 }, (_, i) => `<d:x${i}/>`).join('') + Array.from({ length: 700 }, (_, i) => xmlEntry(`/o${i}`)).join('')), 159_000),
];

test.each(hostileReplies.map((body, index) => ({ body, index })))('159 KB hostile XML shape $index finishes within 500 ms or is refused', async ({ body }) => {
  expect(Buffer.byteLength(body)).toBe(159_000);
  const start = performance.now();
  try {
    await xmlSession(body).propfind('https://dav.test/', ['d:getetag'], '1');
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  }
  expect(performance.now() - start).toBeLessThan(500);
});

test('ordinary 200 KB XML still parses', async () => {
  const body = padReply(xmlReply(Array.from({ length: 1000 }, (_, i) => xmlEntry(`/o${i}`, '<d:getetag>v1</d:getetag>')).join('')), 200_000);
  expect(Buffer.byteLength(body)).toBe(200_000);
  const result = await xmlSession(body).propfind('https://dav.test/', ['d:getetag'], '1');
  expect(result.entries).toHaveLength(1000);
  expect(result.entries[999]).toMatchObject({ href: 'https://dav.test/o999', props: { getetag: 'v1' } });
});

test('three UIDs store only their own components with total bytes close to the original', async () => {
  const { server, ctx } = setup();
  const payload = event('x', 'y', 'z');
  server.put(`${WORK}multi.ics`, payload);
  const objects = (await run(ctx, 'sync-collection', null)).upserts.filter((o) => o.id.startsWith(`${WORK}multi.ics`));
  expect(objects).toHaveLength(3);
  let bytes = 0;
  for (const object of objects) {
    if (typeof object.payload !== 'string') throw new Error('not iCalendar');
    expect(groupUidsOf(object.payload)).toEqual([object.groupUid]);
    bytes += Buffer.byteLength(object.payload);
  }
  expect(bytes).toBeLessThan(Buffer.byteLength(payload) * 1.5);
});

test('101 UIDs are skipped with a warning, deleting earlier single or split objects', async () => {
  const { server, ctx } = setup();
  const warnings: unknown[] = [];
  ctx.log = { ...ctx.log, warn: (message, fields) => warnings.push({ message, fields }) };
  const single = `${WORK}single.ics`;
  const split = `${WORK}split.ics`;
  server.put(single, event('single')).put(split, event('x', 'y'));
  const first = await run(ctx, 'sync-collection', null);
  const payload = event(...Array.from({ length: 101 }, (_, i) => `uid${i}`));
  server.put(single, payload).put(split, payload);
  const next = await run(ctx, 'sync-collection', first.end.cursor);
  expect(next.upserts).toEqual([]);
  expect(next.deletes.sort()).toEqual([single, `${split}#x`, `${split}#y`]);
  expect(next.end.cursor.split).toEqual({});
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toMatchObject({ fields: { count: 101, limit: 100 } });
  expect((await run(ctx, 'sync-collection', null)).upserts.map((o) => o.groupUid)).toEqual(['a', 'b']);
});

test('a single UID keeps its original payload bytes and etag', async () => {
  const { server, ctx } = setup();
  const payload = event('original').replaceAll('\r\n', '\n').replace('VERSION:2.0', 'VERSION:2.0\nX-CUSTOM:untouched');
  server.put(`${WORK}a.ics`, payload);
  const object = (await run(ctx, 'sync-collection', null)).upserts.find((o) => o.id === `${WORK}a.ics`);
  expect(object).toMatchObject({ payload, etag: `"${server.version}"` });
});

/** Sync-only fake used to exercise pagination bounds without repeated XML parsing. */
function syncFake(answer: DavSession['syncCollection']): DavSession {
  return { ...xmlSession(xmlReply('')), syncCollection: answer, multiget: async () => { throw new Error('unexpected multiget'); } };
}
const truncated = (token: string) => ({ url: `https://dav.test${WORK}`, syncToken: token, entries: [{ href: `https://dav.test${WORK}`, status: 507, props: {} }] });

test('a server truncating forever fails at 1000 rounds before yielding anything', async () => {
  let rounds = 0;
  const dav = syncFake(async () => truncated(`tok-${++rounds}`));
  await expect(collect(syncCollection(dav, `https://dav.test${WORK}`, 'sync-collection', null))).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(rounds).toBe(1000);
});

test('a server truncating ten times then finishing succeeds', async () => {
  let rounds = 0;
  const dav = syncFake(async () => ({ ...truncated(`tok-${++rounds}`), ...(rounds > 10 && { entries: [] }) }));
  expect(await collect(syncCollection(dav, `https://dav.test${WORK}`, 'sync-collection', null))).toMatchObject([{ kind: 'end', mode: 'snapshot', cursor: { token: 'tok-11' } }]);
  expect(rounds).toBe(11);
});

test('sync-collection refuses more than 200000 distinct hrefs, even in a final answer', async () => {
  const dav = syncFake(async () => ({ ...truncated('tok-1'), entries: Array.from({ length: 200001 }, (_, i) => ({ href: `https://dav.test${WORK}${i}.ics`, status: 200, props: { getetag: 'v1' } })) }));
  await expect(collect(syncCollection(dav, `https://dav.test${WORK}`, 'sync-collection', null))).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test('only one invalid-token restart is allowed, and it resets the round budget', async () => {
  let calls = 0;
  const dav = syncFake(async (_url, token) => {
    calls++;
    if (calls === 1000 || calls === 2000) throw new DavStatusError(403, '<d:valid-sync-token/>');
    if (calls === 1001) expect(token).toBe('');
    return truncated(`tok-${calls}`);
  });
  await expect(collect(syncCollection(dav, `https://dav.test${WORK}`, 'sync-collection', null))).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(calls).toBe(2000);
});

test.each(['https://dav.test:8443/u/', 'http://dav.test/u/'])('a discovery href to %s fails before sending credentials', async (href) => {
  const { ctx } = setup();
  const sent: string[] = [];
  ctx.fetch = async (req) => {
    sent.push(req.url);
    return { status: 207, headers: new Headers({ 'content-type': 'application/xml' }), body: new TextEncoder().encode(xmlReply(xmlEntry('/', `<d:current-user-principal><d:href>${href}</d:href></d:current-user-principal>`))), finalUrl: req.url };
  };
  await expect(caldavAdapter.listCalendars(ctx)).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(sent).toEqual(['https://dav.test/.well-known/caldav']);
});

test('a configured HTTP origin may upgrade to HTTPS on its hostname', async () => {
  const { server } = setup();
  const inner = server.asGuardedFetch();
  const sent: string[] = [];
  const ctx = davContext(async (req) => {
    sent.push(req.url);
    const response = await inner(req);
    return { ...response, finalUrl: req.url.replace('http://dav.test:8080/', 'https://dav.test/') };
  }, { provider: 'caldav', serverUrl: 'http://dav.test:8080/', username: 'u', password: 'p' });
  expect((await caldavAdapter.listCalendars(ctx))[0]?.providerCalendarId).toBe(`https://dav.test${WORK}`);
  expect(sent.slice(0, 2)).toEqual(['http://dav.test:8080/.well-known/caldav', 'https://dav.test/u/']);
  expect((await run(ctx, 'sync-collection', null)).upserts).toHaveLength(2);
});

test.each(['https://p42-caldav.icloud.com/', 'https://p42-caldav.icloud.com:443/'])('iCloud partition %s receives credential permission', async (url) => {
  const requests: GuardedRequest[] = [];
  const fixture = new DavFixture().collection(WORK);
  const ctx = davContext(async (req) => { requests.push(req); return fixture.asGuardedFetch()(req); }, { provider: 'icloud', appleId: 'u', appSpecificPassword: 'p' });
  const login = icloudLogin(ctx.credentials);
  const dav = createDavSession(ctx, login);
  await dav.propfind(new URL('/.well-known/caldav', url).href, ['d:getetag'], '1');
  expect(requests).toHaveLength(1);
  expect(credentialTarget(new URL(url), requests[0]?.credentialOrigins ?? [], requests[0]?.credentialHosts ?? [])).toBe(true);
});

test.each(['https://p42-caldav.icloud.com:8443/', 'http://p42-caldav.icloud.com/'])('iCloud partition %s receives no credentials', async (url) => {
  const sent: unknown[] = [];
  const ctx = davContext(async (req) => { sent.push(req); throw new Error('unexpected fetch'); }, { provider: 'icloud', appleId: 'u', appSpecificPassword: 'p' });
  await expect(createDavSession(ctx, icloudLogin(ctx.credentials)).propfind(url, [], '0')).rejects.toBeInstanceOf(ProviderUnavailableError);
  expect(sent).toEqual([]);
});


test.each(['', ':443', ':8443'])('iCloud redirect to HTTPS partition port "%s" keeps Basic only on the default port', async (port) => {
  const authorization: (string | null)[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    authorization.push(new Headers(init?.headers).get('authorization'));
    return authorization.length === 1
      ? Response.redirect(`https://p42-caldav.icloud.com${port}/`)
      : new Response(xmlReply(''), { status: 207, headers: { 'content-type': 'application/xml' } });
  }, { preconnect() {} }));
  try {
    const guarded = createGuardedFetch({ allow: [] }, { resolve: async () => [{ address: '1.1.1.1', family: 4 }] });
    const ctx = davContext(guarded, { provider: 'icloud', appleId: 'u', appSpecificPassword: 'p' });
    const dav = createDavSession(ctx, icloudLogin(ctx.credentials));
    await dav.propfind('https://caldav.icloud.com/', [], '0');
    const basic = `Basic ${btoa('u:p')}`;
    expect(authorization).toEqual([basic, port === ':8443' ? null : basic]);
  } finally {
    fetch.mockRestore();
  }
});
