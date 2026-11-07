import { XMLParser } from 'fast-xml-parser';

export type DavObject = { href: string; etag: string; ical: string };
export type DavCalendar = { href: string; name?: string; color?: string; ctag?: string; syncToken?: string; components: string[]; syncCollection: boolean };
export type DavCursor = { mode: 'sync' | 'etag'; token?: string; ctag?: string; etags: Record<string, string> };
export type DavSync = { upserts: DavObject[]; deletes: string[]; nextCursor: DavCursor; fullResync: boolean };
export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: string; url: string }>;
const ns = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/"';
export const escapeXml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, processEntities: true, trimValues: false });
export function record(v: unknown): Record<string, unknown> { return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}; }
const list = (v: unknown): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
function xml(s: string) { if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new Error('XML entities/DTD forbidden'); return record(parser.parse(s)); }
function multistatus(s: string) {
  const parsed = xml(s); const root = record(parsed.multistatus);
  if (!('multistatus' in parsed)) throw new Error('Missing DAV multistatus');
  return { token: str(root['sync-token']), rows: list(root.response).map(v => {
    const r = record(v); const props: Record<string, unknown> = {};
    for (const ps of list(r.propstat)) {
      const p = record(ps); if (str(p.status)?.includes(' 200 ')) Object.assign(props, record(p.prop));
    }
    return { href: str(r.href) ?? '', status: str(r.status), props };
  }) };
}
export class DavError extends Error { constructor(public status: number, public body: string) { super(`DAV HTTP ${status}: ${body.slice(0, 180)}`); } }
const calendarProps = '<d:resourcetype/><d:displayname/><a:calendar-color/><cs:getctag/><d:sync-token/><c:supported-calendar-component-set/><d:supported-report-set/>';

/** Small lab client; production needs namespace-URI validation, bounded pagination and credential-scoped redirects. */
export class CalDavClient {
  constructor(private transport: Transport) {}
  async request(url: string, method: string, body = '', depth = '0') {
    const r = await this.transport(url, { method, headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body });
    if (r.status < 200 || r.status >= 300) throw new DavError(r.status, r.text);
    return { ...multistatus(r.text), url: r.url };
  }
  propfind(url: string, props: string, depth = '0') { return this.request(url, 'PROPFIND', `<d:propfind ${ns}><d:prop>${props}</d:prop></d:propfind>`, depth); }
  async discover(base: string) {
    let root;
    try { root = await this.propfind(new URL('/.well-known/caldav', base).href, '<d:current-user-principal/>'); }
    catch (e) { if (!(e instanceof DavError) || ![404, 405].includes(e.status)) throw e; root = await this.propfind(base, '<d:current-user-principal/>'); }
    const principalHref = str(record(root.rows[0]?.props['current-user-principal']).href);
    if (!principalHref) throw new Error('No principal');
    const principal = new URL(principalHref, root.url).href;
    const p = await this.propfind(principal, '<c:calendar-home-set/>');
    const homeHref = str(record(p.rows[0]?.props['calendar-home-set']).href);
    if (!homeHref) throw new Error('No calendar home');
    return { principal, home: new URL(homeHref, p.url).href };
  }
  async listCalendars(home: string): Promise<DavCalendar[]> {
    const result = await this.propfind(home, calendarProps, '1');
    return result.rows.filter(r => 'calendar' in record(r.props.resourcetype)).map(r => this.calendar(r.href, r.props, result.url));
  }
  private calendar(href: string, p: Record<string, unknown>, base: string): DavCalendar {
    const reports = list(record(p['supported-report-set'])['supported-report']);
    return { href: new URL(href, base).href, name: str(p.displayname), color: str(p['calendar-color']), ctag: str(p.getctag), syncToken: str(p['sync-token']),
      components: list(record(p['supported-calendar-component-set']).comp).map(c => str(record(c)['@_name']) ?? ''),
      syncCollection: reports.some(r => 'sync-collection' in record(record(r).report)) };
  }
  async metadata(href: string) { const r = await this.propfind(href, calendarProps); const p = r.rows[0]; if (!p) throw new Error('No collection'); return this.calendar(p.href, p.props, r.url); }
  async query(href: string, withData = false) {
    return this.request(href, 'REPORT', `<c:calendar-query ${ns}><d:prop><d:getetag/>${withData ? '<c:calendar-data/>' : ''}</d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`, '1');
  }
  async multiget(calendar: string, hrefs: string[]): Promise<DavObject[]> {
    if (!hrefs.length) return [];
    const r = await this.request(calendar, 'REPORT', `<c:calendar-multiget ${ns}><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefs.map(h => `<d:href>${escapeXml(new URL(h).pathname)}</d:href>`).join('')}</c:calendar-multiget>`, '1');
    const expected = new Set(hrefs);
    if (r.rows.length !== expected.size) throw new Error('Incomplete multiget response');
    return r.rows.map(row => {
      const absolute = new URL(row.href, r.url).href;
      if (!expected.delete(absolute)) throw new Error('Unexpected/duplicate multiget href');
      const etag = str(row.props.getetag), ical = str(row.props['calendar-data']);
      if (!etag || !ical) throw new Error('Concurrent disappearance or failed multiget; retry without committing cursor');
      return { href: new URL(row.href, r.url).href, etag, ical };
    });
  }
  async sync(calendar: DavCalendar, cursor?: DavCursor, forceFallback = false): Promise<DavSync> {
    if (!forceFallback && calendar.syncCollection && cursor?.mode !== 'etag') {
      try {
        const r = await this.request(calendar.href, 'REPORT', `<d:sync-collection ${ns}><d:sync-token>${escapeXml(cursor?.token ?? '')}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`, '1');
        if (!r.token) throw new Error('Missing sync token');
        const deletes: string[] = [], changed: string[] = []; const etags = { ...cursor?.etags };
        for (const row of r.rows) {
          const href = new URL(row.href, r.url).href;
          if (row.status?.includes(' 404 ')) { deletes.push(href); delete etags[href]; }
          else if (str(row.props.getetag)) changed.push(href);
          else throw new Error('Incomplete sync response');
        }
        const upserts = await this.multiget(calendar.href, changed);
        for (const o of upserts) etags[o.href] = o.etag;
        return { upserts, deletes, fullResync: !cursor, nextCursor: { mode: 'sync', token: r.token, etags } };
      } catch (e) {
        if (!(e instanceof DavError)) throw e;
        if (e.status === 403 && /valid-sync-token/.test(e.body) && cursor) {
          const full = await this.sync(calendar); return { ...full, fullResync: true, deletes: Object.keys(cursor.etags).filter(h => !(h in full.nextCursor.etags)) };
        }
        if (![405, 501].includes(e.status)) throw e; // Never turn auth/server failures into deletions.
      }
    }
    const metadata = await this.metadata(calendar.href);
    if (cursor?.mode === 'etag' && metadata.ctag && metadata.ctag === cursor.ctag) return { upserts: [], deletes: [], nextCursor: cursor, fullResync: false };
    const listing = await this.query(calendar.href);
    const etags: Record<string, string> = {};
    for (const row of listing.rows) { const tag = str(row.props.getetag); if (!tag) throw new Error('Incomplete etag listing'); etags[new URL(row.href, listing.url).href] = tag; }
    const changed = Object.keys(etags).filter(h => cursor?.etags[h] !== etags[h]);
    const upserts = await this.multiget(calendar.href, changed);
    // Keep listing ETags: a mutation during multiget must be seen on the next poll.
    return { upserts, deletes: Object.keys(cursor?.etags ?? {}).filter(h => !(h in etags)), fullResync: !cursor, nextCursor: { mode: 'etag', ctag: metadata.ctag, etags } };
  }
}
