/**
 * The ICS/webcal adapter: one calendar per URL, fetched with a conditional GET. A 304 is an empty
 * delta; any other success is a full snapshot, split into one raw object per UID (a VCALENDAR with
 * that UID's events and the VTIMEZONEs they use), so UIDs that left the feed are swept by the
 * runner. The URL is a secret: it lives only in the encrypted credentials and is never logged.
 */
import { componentsOf, parseCalendar, propName, propValues, serializeCalendar, type JCalProperty } from '@supercal/core';
import { z } from 'zod';
import { AuthFailedError, ProviderThrottledError, ProviderUnavailableError, type AdapterContext, type ProviderAdapter, type RawObject, type SourceCalendarInfo } from '../adapter.ts';
import { normalizeColor, validZone } from '../caldav/discovery.ts';
import { EgressBlockedError, type GuardedResponse } from '../transport/index.ts';

export const IcsCursor = z.object({ v: z.literal(1), etag: z.string().nullable(), lastModified: z.string().nullable() });
export type IcsCursor = z.infer<typeof IcsCursor>;

const FEED_ID = 'feed';
const PAGE = 500;
const MINUTE = 60_000;
const POLL_MIN_MS = 5 * MINUTE;
const POLL_MAX_MS = 60 * MINUTE;

const urlOf = (ctx: AdapterContext) => {
  if (ctx.credentials.provider !== 'ics') throw new AuthFailedError('these are not ICS credentials');
  return ctx.credentials.url;
};

/** Fetches the feed. Failures never look like an empty feed; the URL never appears in a message. */
async function get(ctx: AdapterContext, cursor: IcsCursor | null): Promise<GuardedResponse> {
  const url = new URL(urlOf(ctx).replace(/^webcal:/i, 'https:'));
  const headers: Record<string, string> = { accept: 'text/calendar, */*;q=0.5' };
  if (cursor?.etag) headers['if-none-match'] = cursor.etag;
  if (cursor?.lastModified) headers['if-modified-since'] = cursor.lastModified;
  const guarded = ctx.fetch;
  const response = await guarded({ url: url.href, headers, signal: ctx.signal }).catch((error: unknown) => {
    if (error instanceof EgressBlockedError || ctx.signal.aborted) throw error;
    throw new ProviderUnavailableError(`could not fetch the feed from ${url.host}`, { cause: error });
  });
  const { status } = response;
  if (status === 401 || status === 403) throw new AuthFailedError(`${url.host} refused the feed (HTTP ${status})`);
  if (status === 429) throw new ProviderThrottledError(Number(response.headers.get('retry-after')) * 1000 || MINUTE);
  if (status !== 200 && !(status === 304 && cursor)) throw new ProviderUnavailableError(`${url.host} answered HTTP ${status}`);
  return response;
}

/** Parses a feed body. It must be a VCALENDAR whatever the content type says; anything else is unavailable, never empty. */
function parseFeed(body: Uint8Array) {
  const text = new TextDecoder().decode(body);
  if (!/^\s*BEGIN:VCALENDAR\r?\n/i.test(text) || !/^END:VCALENDAR\s*$/im.test(text)) throw new ProviderUnavailableError('the feed is not an iCalendar document');
  const parsed = parseCalendar(text);
  if (parsed.errors.some((e) => e.component === 'vcalendar')) throw new ProviderUnavailableError('the feed has a malformed VCALENDAR');
  return parsed;
}

const calendarProp = (props: JCalProperty[], name: string): string | null => {
  const value = propValues(props.find((p) => propName(p) === name) ?? [name, {}, 'text'])[0];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** When to poll next: `Cache-Control: max-age`, else `Expires`, clamped to 5–60 min. */
export function pollHint(headers: Headers, now = Date.now()): { afterMs: number } | undefined {
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(headers.get('cache-control') ?? '')?.[1];
  const expires = Date.parse(headers.get('expires') ?? '');
  const wanted = maxAge !== undefined ? Number(maxAge) * 1000 : Number.isNaN(expires) ? undefined : expires - (Date.parse(headers.get('date') ?? '') || now);
  return wanted === undefined ? undefined : { afterMs: Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, wanted)) };
}

const revision = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

/**
 * The feed's raw objects, one per UID. A component that failed to parse keeps its UID's last good
 * version (a touch) instead of being swept as gone.
 */
export function feedObjects(parsed: ReturnType<typeof parseCalendar>): RawObject[] {
  const objects: RawObject[] = parsed.resources
    .filter((resource) => componentsOf(resource).length > 0)
    .map((resource) => {
      const payload = serializeCalendar({ props: [], resources: [resource] });
      return { id: resource.uid, etag: revision(payload), groupUid: resource.uid, payload };
    });
  const seen = new Set(objects.map((o) => o.id));
  for (const { uid } of parsed.errors) {
    if (uid === null || seen.has(uid)) continue;
    seen.add(uid);
    objects.push({ id: uid, etag: '', groupUid: uid, payload: null });
  }
  return objects;
}

export const icsAdapter: ProviderAdapter<IcsCursor> = {
  provider: 'ics',
  format: 'ical',
  capabilities: { calendarDiscovery: 'single', push: 'none' },

  async listCalendars(ctx): Promise<SourceCalendarInfo[]> {
    const { calendarProps } = parseFeed((await get(ctx, null)).body);
    const timezone = calendarProp(calendarProps, 'x-wr-timezone');
    return [
      {
        providerCalendarId: FEED_ID,
        name: calendarProp(calendarProps, 'x-wr-calname') ?? calendarProp(calendarProps, 'name') ?? new URL(urlOf(ctx).replace(/^webcal:/i, 'https:')).host,
        color: normalizeColor(calendarProp(calendarProps, 'x-apple-calendar-color') ?? calendarProp(calendarProps, 'color')),
        timezone: timezone && validZone(timezone) ? timezone : null,
        capabilities: { incremental: 'conditional-get', push: false },
      },
    ];
  },

  async *sync(ctx, _calendar, stored) {
    const cursor = IcsCursor.safeParse(stored).data ?? null;
    const response = await get(ctx, cursor);
    const nextPollHint = pollHint(response.headers);
    if (response.status === 304 && cursor) {
      yield { kind: 'end', mode: 'delta', cursor, ...(nextPollHint && { nextPollHint }) };
      return;
    }
    const objects = feedObjects(parseFeed(response.body));
    for (let i = 0; i < objects.length; i += PAGE) yield { kind: 'page', upserts: objects.slice(i, i + PAGE), deletes: [] };
    const next: IcsCursor = { v: 1, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    yield { kind: 'end', mode: 'snapshot', cursor: next, ...(nextPollHint && { nextPollHint }) };
  },
};
