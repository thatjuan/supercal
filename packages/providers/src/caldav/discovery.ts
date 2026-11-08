/**
 * CalDAV calendar discovery from a server URL: `/.well-known/caldav` (or the URL itself) →
 * `current-user-principal` → `calendar-home-set` → a Depth 1 PROPFIND on the home, keeping the
 * calendar collections that hold VEVENTs. RFC 6764 SRV and email-domain discovery are deferred.
 */
import { z } from 'zod';
import { ProviderUnavailableError, type SourceCalendarInfo } from '../adapter.ts';
import { DavStatusError, Text, type DavResult, type DavSession } from './session.ts';

/** How a collection syncs: RFC 6578 sync-collection, or the ctag/etag listing diff. */
export type Incremental = 'sync-collection' | 'etag';

const many = <T extends z.ZodType>(schema: T) => z.union([z.array(schema), schema.transform((one) => [one])]);
const Href = z.object({ href: many(Text) }).transform((p) => p.href[0]);
const ResourceType = z.record(z.string(), z.unknown());
const Components = z.object({ comp: many(z.object({ _attributes: z.object({ name: z.string() }) })) }).transform((s) => s.comp.map((c) => c._attributes.name.toUpperCase()));
const Reports = z.object({ supportedReport: many(z.object({ report: z.record(z.string(), z.unknown()) })) }).transform((s) => s.supportedReport.flatMap((r) => Object.keys(r.report)));

/** The value of an optional property, or null when it is absent or unreadable. */
const read = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const firstHref = (result: DavResult, prop: string): string | null => {
  for (const entry of result.entries) {
    const href = read(Href, entry.props[prop]);
    if (href) return new URL(href, result.url).href;
  }
  return null;
};

/** Apple's `calendar-color` (`#RRGGBB` or `#RRGGBBAA`) as `#RRGGBB`. */
export function normalizeColor(value: string | null): string | null {
  const hex = value && /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim())?.[1];
  return hex ? `#${hex.toUpperCase()}` : null;
}

/** Whether `tzid` is a time zone the runtime knows (an IANA name). */
export function validZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/** The IANA TZID of a `calendar-timezone` VTIMEZONE, if it names one. */
export function ianaZone(vtimezone: string | null): string | null {
  const tzid = vtimezone && /^TZID[^:]*:(.+)$/im.exec(vtimezone)?.[1]?.trim();
  return tzid && validZone(tzid) ? tzid : null;
}

/** The account's calendar home URL, discovered from `serverUrl`. */
export async function discoverHome(dav: DavSession, serverUrl: string): Promise<string> {
  const principalAt = async (url: string, handled?: number[]) => firstHref(await dav.propfind(url, ['d:current-user-principal'], '0', handled), 'currentUserPrincipal');
  const wellKnown = await principalAt(new URL('/.well-known/caldav', serverUrl).href, [400, 404, 405, 501]).catch((error: unknown) => {
    if (error instanceof DavStatusError) return null;
    throw error;
  });
  const principal = wellKnown ?? (await principalAt(serverUrl));
  if (!principal) throw new ProviderUnavailableError('the server did not name a current-user-principal; is this a CalDAV server?');
  const home = firstHref(await dav.propfind(principal, ['c:calendar-home-set'], '0'), 'calendarHomeSet');
  if (!home) throw new ProviderUnavailableError('the CalDAV principal has no calendar-home-set');
  return home;
}

/** The event calendars under `home`, each with its incremental mode. */
export async function listCollections(dav: DavSession, home: string): Promise<SourceCalendarInfo[]> {
  const result = await dav.propfind(
    home,
    ['d:resourcetype', 'd:displayname', 'ca:calendar-color', 'c:calendar-timezone', 'd:sync-token', 'c:supported-calendar-component-set', 'd:supported-report-set'],
    '1',
  );
  return result.entries.flatMap((entry): SourceCalendarInfo[] => {
    const props = entry.props;
    if (!('calendar' in (read(ResourceType, props.resourcetype) ?? {}))) return [];
    // An absent component set means every component type (RFC 4791 §5.2.3).
    const components = read(Components, props.supportedCalendarComponentSet);
    if (components && !components.includes('VEVENT')) return [];
    const reports = read(Reports, props.supportedReportSet);
    const incremental: Incremental = (reports ? reports.includes('syncCollection') : read(Text, props.syncToken) !== null) ? 'sync-collection' : 'etag';
    const name = read(Text, props.displayname)?.trim();
    return [
      {
        providerCalendarId: entry.href,
        name: name || decodeURIComponent(new URL(entry.href).pathname.split('/').filter(Boolean).at(-1) ?? 'Calendar'),
        color: normalizeColor(read(Text, props.calendarColor)),
        timezone: ianaZone(read(Text, props.calendarTimezone)),
        capabilities: { incremental, push: false },
      },
    ];
  });
}
