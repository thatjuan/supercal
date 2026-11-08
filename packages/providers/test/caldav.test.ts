/**
 * The CalDAV adapter (tsdav over a scripted guarded transport): discovery, both incremental modes
 * and the failure rules, where an error must never yield a cursor or a deletion.
 */
import { describe, expect, test } from 'bun:test';
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
