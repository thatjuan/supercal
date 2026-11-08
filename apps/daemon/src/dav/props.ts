/**
 * WebDAV properties of each node in a feed's tree (architecture §9) and the multistatus pieces
 * built from them. Property values are inner XML, computed by the caller beforehand; a requested
 * property a node lacks is answered in a 404 propstat.
 */
import { NS, esc, type XmlEl, type XmlWriter } from './xml.ts';

type Ns = (typeof NS)[keyof typeof NS];

/** `ns|name` → inner XML. */
export type Props = Map<string, string>;
/** Requested properties, or every property but `calendar-data` (`allprop`, an empty body). */
export type Want = { ns: string; name: string }[] | 'all';

const key = (ns: string, name: string) => `${ns}|${name}`;
const props = (entries: [Ns, string, string | null | undefined][]): Props =>
  new Map(entries.flatMap(([ns, name, value]) => (value == null ? [] : [[key(ns, name), value] as const])));

const href = (path: string) => `<d:href>${esc(path)}</d:href>`;

/** Baseline privileges for feeds and read-only collections. */
const READ_ONLY = '<d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege>';
const reports = (freeBusy: boolean) => ['cal:calendar-query', 'cal:calendar-multiget', 'd:sync-collection', ...(freeBusy ? ['cal:free-busy-query'] : [])]
  .map((r) => `<d:supported-report><d:report><${r}/></d:report></d:supported-report>`)
  .join('');

export type Privilege = 'read' | 'home' | 'write' | 'manage';
export type Account = { principal: string; home: string; displayName: string; email: string | null; writable?: boolean };

const privileges = (p: Privilege) => READ_ONLY + (p === 'read' ? '' : '<d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>')
  + (p === 'write' || p === 'manage' ? '<d:privilege><d:write-content/></d:privilege>' : '')
  + (p === 'manage' ? '<d:privilege><d:write/></d:privilege><d:privilege><d:write-properties/></d:privilege>' : '');

const common = (a: Account, privilege: Privilege = 'read'): [Ns, string, string][] => [
  [NS.DAV, 'current-user-principal', href(a.principal)],
  [NS.DAV, 'current-user-privilege-set', privileges(privilege)],
];

/** `/` and `/dav/`: enough for discovery to find the principal. */
export const rootProps = (a: Account) => props([...common(a), [NS.DAV, 'resourcetype', '<d:collection/>']]);

export const principalProps = (a: Account) =>
  props([
    ...common(a),
    [NS.DAV, 'resourcetype', '<d:principal/>'],
    [NS.DAV, 'displayname', esc(a.displayName)],
    [NS.DAV, 'principal-URL', href(a.principal)],
    [NS.CALDAV, 'calendar-home-set', href(a.home)],
    [NS.CALDAV, 'calendar-user-address-set', a.email && href(`mailto:${a.email}`)],
  ]);

export const homeProps = (a: Account) =>
  props([...common(a, a.writable ? 'home' : 'read'), [NS.DAV, 'resourcetype', '<d:collection/>'], [NS.DAV, 'displayname', esc(a.displayName)]]);

export type Collection = { name: string; color: string | null; sortOrder: number; token: string; description?: string | null; timezone?: string | null; maxResourceSize?: number };

/** A calendar collection. `color` is `#rrggbb`; Apple wants `#RRGGBBAA`. */
export const collectionProps = (a: Account, c: Collection, privilege: Privilege = 'read') =>
  props([
    ...common(a, privilege),
    [NS.DAV, 'resourcetype', '<d:collection/><cal:calendar/>'],
    [NS.DAV, 'displayname', esc(c.name)],
    [NS.APPLE, 'calendar-color', c.color && `${c.color.toUpperCase()}FF`],
    [NS.APPLE, 'calendar-order', String(c.sortOrder)],
    [NS.CS, 'getctag', esc(c.token)],
    [NS.DAV, 'sync-token', esc(c.token)],
    [NS.CALDAV, 'supported-calendar-component-set', '<cal:comp name="VEVENT"/>'],
    [NS.DAV, 'supported-report-set', reports(a.writable ?? false)],
    [NS.CALDAV, 'calendar-description', c.description == null ? null : esc(c.description)],
    [NS.CALDAV, 'calendar-timezone', c.timezone == null ? null : esc(c.timezone)],
    [NS.CALDAV, 'max-resource-size', c.maxResourceSize === undefined ? null : String(c.maxResourceSize)],
  ]);

/** An object; `ics` only when the caller rendered it (reports), never in listings. */
export const objectProps = (etag: string, ics?: string) =>
  props([
    [NS.DAV, 'resourcetype', ''],
    [NS.DAV, 'getetag', esc(etag)],
    [NS.DAV, 'getcontenttype', 'text/calendar; charset=utf-8; component=vevent'],
    [NS.CALDAV, 'calendar-data', ics === undefined ? null : esc(ics)],
  ]);

/** The properties a PROPFIND or REPORT body asks for. */
export function wanted(request: XmlEl | undefined): Want {
  const prop = request?.children.find((c) => c.ns === NS.DAV && c.name === 'prop');
  return prop ? prop.children.map(({ ns, name }) => ({ ns, name })) : 'all';
}

const ALL_EXCLUDES = key(NS.CALDAV, 'calendar-data');

/** One `<d:response>` with a 200 propstat for the properties found and a 404 one for the rest. */
export function propResponse(w: XmlWriter, path: string, available: Props, want: Want): string {
  const list =
    want === 'all'
      ? [...available.keys()].filter((k) => k !== ALL_EXCLUDES).map((k) => ({ ns: k.slice(0, k.indexOf('|')), name: k.slice(k.indexOf('|') + 1) }))
      : want;
  const found: string[] = [];
  const missing: string[] = [];
  for (const { ns, name } of list) {
    const q = w.qname(ns, name);
    const value = available.get(key(ns, name));
    if (value === undefined) missing.push(`<${q}/>`);
    else found.push(value === '' ? `<${q}/>` : `<${q}>${value}</${q}>`);
  }
  const stat = (inner: string[], status: string) =>
    inner.length ? `<d:propstat><d:prop>${inner.join('')}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>` : '';
  return `<d:response>${href(path)}${stat(found, '200 OK')}${stat(missing, '404 Not Found')}</d:response>`;
}

/** A `<d:response>` carrying only a status, e.g. a deleted member in sync-collection. */
export const statusResponse = (path: string, status: '404 Not Found' | '507 Insufficient Storage') =>
  `<d:response>${href(path)}<d:status>HTTP/1.1 ${status}</d:status></d:response>`;
