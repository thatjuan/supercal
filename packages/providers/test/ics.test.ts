/**
 * The ICS adapter over a scripted guarded transport: conditional GET, per-UID raw objects, the
 * body rules (HTML is a failure, an empty VCALENDAR is a legitimate empty snapshot) and polling hints.
 */
import { describe, expect, test } from 'bun:test';
import { AuthFailedError, icsAdapter, ProviderUnavailableError, type GuardedRequest, type IcsCursor, type SourceCalendarRef, type SyncEnd, type SyncPage } from '../src/index.ts';
import { pollHint } from '../src/ics/index.ts';
import { collect, davContext } from './dav-fixture.ts';

const URL_ = 'webcal://feeds.example.test/s3cret.ics';
const ref: SourceCalendarRef = { id: 'cal_1', providerCalendarId: 'feed', capabilities: { incremental: 'conditional-get', push: false } };

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//feed//EN',
  'X-WR-CALNAME:Team holidays',
  'X-WR-TIMEZONE:Europe/Berlin',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:series',
  'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Berlin:20261109T090000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Standup',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series',
  'DTSTAMP:20260101T000000Z',
  'RECURRENCE-ID;TZID=Europe/Berlin:20261116T090000',
  'DTSTART;TZID=Europe/Berlin:20261116T110000',
  'SUMMARY:Moved standup',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:day',
  'DTSTAMP:20260101T000000Z',
  'DTSTART;VALUE=DATE:20261110',
  'SUMMARY:Day off',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** A scripted feed host: `reply` answers each GET; requests are recorded. */
function feed(reply: (req: GuardedRequest) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const requests: GuardedRequest[] = [];
  const ctx = davContext(
    async (req) => {
      requests.push(req);
      const { status = 200, body = '', headers = {} } = reply(req);
      return { status, headers: new Headers(headers), body: new TextEncoder().encode(body), finalUrl: req.url };
    },
    { provider: 'ics', url: URL_ },
  );
  return { ctx, requests };
}

type Item = SyncPage | SyncEnd<IcsCursor>;
async function sync(ctx: ReturnType<typeof davContext>, cursor: IcsCursor | null) {
  const items: Item[] = await collect(icsAdapter.sync(ctx, ref, cursor));
  const end = items.at(-1);
  if (end?.kind !== 'end') throw new Error('no end item');
  return { end, pages: items.filter((i): i is SyncPage => i.kind === 'page') };
}

describe('listCalendars', () => {
  test('one calendar named from X-WR-CALNAME, falling back to the host', async () => {
    expect(await icsAdapter.listCalendars(feed(() => ({ body: FEED })).ctx)).toEqual([
      { providerCalendarId: 'feed', name: 'Team holidays', color: null, timezone: 'Europe/Berlin', capabilities: { incremental: 'conditional-get', push: false } },
    ]);
    const [unnamed] = await icsAdapter.listCalendars(feed(() => ({ body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' })).ctx);
    expect(unnamed?.name).toBe('feeds.example.test');
  });
});

describe('sync', () => {
  test('a feed is a snapshot of one raw object per UID, each a VCALENDAR with its events and zones', async () => {
    const { ctx, requests } = feed(() => ({ body: FEED, headers: { etag: '"v1"', 'last-modified': 'Sat, 07 Nov 2026 00:00:00 GMT' } }));
    const { end, pages } = await sync(ctx, null);
    expect(requests[0]?.url).toBe('https://feeds.example.test/s3cret.ics');
    expect(end).toMatchObject({ mode: 'snapshot', cursor: { v: 1, etag: '"v1"', lastModified: 'Sat, 07 Nov 2026 00:00:00 GMT' } });
    const [series, day] = pages.flatMap((p) => p.upserts);
    expect([series?.id, series?.groupUid, day?.id]).toEqual(['series', 'series', 'day']);
    expect(series?.payload).toContain('RECURRENCE-ID');
    expect(series?.payload).toContain('BEGIN:VTIMEZONE');
    expect(series?.payload).not.toContain('UID:day');
    expect(day?.payload).not.toContain('VTIMEZONE');
    expect(series?.etag).toMatch(/^[0-9a-f]{64}$/);

    const again = await sync(feed(() => ({ body: FEED })).ctx, null);
    expect(again.pages.flatMap((p) => p.upserts).map((o) => o.etag)).toEqual([series?.etag ?? '', day?.etag ?? '']);
  });

  test('sends the stored validators; a 304 is an empty delta keeping the cursor', async () => {
    const cursor: IcsCursor = { v: 1, etag: '"v1"', lastModified: 'Sat, 07 Nov 2026 00:00:00 GMT' };
    const { ctx, requests } = feed(() => ({ status: 304, headers: { 'cache-control': 'max-age=900' } }));
    expect(await sync(ctx, cursor)).toEqual({ end: { kind: 'end', mode: 'delta', cursor, nextPollHint: { afterMs: 900_000 } }, pages: [] });
    expect(requests[0]?.headers).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Sat, 07 Nov 2026 00:00:00 GMT' });
  });

  test('an HTML body is ProviderUnavailableError with no pages, whatever the content type says', async () => {
    const items: Item[] = [];
    const run = async () => {
      for await (const item of icsAdapter.sync(feed(() => ({ body: '<!doctype html><title>Sign in</title>', headers: { 'content-type': 'text/calendar' } })).ctx, ref, null)) items.push(item);
    };
    await expect(run()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(items).toEqual([]);
  });

  test('a valid empty VCALENDAR is an empty snapshot, which deletes everything', async () => {
    expect(await sync(feed(() => ({ body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nEND:VCALENDAR\r\n' })).ctx, null)).toMatchObject({ end: { mode: 'snapshot' }, pages: [] });
  });

  test('sloppy MIME and a BOM are fine when the body is a VCALENDAR', async () => {
    const { pages } = await sync(feed(() => ({ body: `﻿${FEED}`, headers: { 'content-type': 'application/octet-stream' } })).ctx, null);
    expect(pages.flatMap((p) => p.upserts)).toHaveLength(2);
  });

  test('a VEVENT that fails to parse keeps its UID (a touch) instead of being swept', async () => {
    const broken = FEED.replace('UID:day\r\n', 'UID:day\r\nthis line has no colon\r\n');
    const upserts = (await sync(feed(() => ({ body: broken })).ctx, null)).pages.flatMap((p) => p.upserts);
    expect(upserts.find((o) => o.id === 'day')?.payload).toBeNull();
  });

  test('401/403 are AuthFailedError, other failures ProviderUnavailableError', async () => {
    await expect(sync(feed(() => ({ status: 403 })).ctx, null)).rejects.toBeInstanceOf(AuthFailedError);
    await expect(sync(feed(() => ({ status: 404 })).ctx, null)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(sync(feed(() => ({ status: 304 })).ctx, null)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

test('the poll hint comes from max-age, else Expires, clamped to 5–60 min', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  expect(pollHint(new Headers({ 'cache-control': 'public, max-age=60' }), now)).toEqual({ afterMs: 5 * 60_000 });
  expect(pollHint(new Headers({ 'cache-control': 'max-age=1800' }), now)).toEqual({ afterMs: 30 * 60_000 });
  expect(pollHint(new Headers({ expires: 'Sat, 07 Nov 2026 06:00:00 GMT' }), now)).toEqual({ afterMs: 60 * 60_000 });
  expect(pollHint(new Headers({ expires: 'Sat, 07 Nov 2026 00:20:00 GMT', date: 'Sat, 07 Nov 2026 00:00:00 GMT' }), now)).toEqual({ afterMs: 20 * 60_000 });
  expect(pollHint(new Headers(), now)).toBeUndefined();
});
