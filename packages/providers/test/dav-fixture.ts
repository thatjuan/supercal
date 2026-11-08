/**
 * A scripted in-memory CalDAV server for adapter tests: one principal, one home and its
 * collections, with sync tokens per change. Knobs script the quirks the adapter must survive.
 * `asGuardedFetch` serves it without a network; `handle` also fits `Bun.serve`.
 *
 *   const server = new DavFixture().collection('/u/cals/work/', { name: 'Work' });
 *   server.put('/u/cals/work/a.ics', event('a'));
 *   const ctx = davContext(server.asGuardedFetch());
 */
import type { AdapterContext, GuardedFetch, ProviderCredentials } from '../src/index.ts';

type Collection = {
  name: string;
  color?: string;
  components: string[];
  reports: string[];
  objects: Map<string, { etag: string; data: string }>;
  /** Paths by the version that last changed them. */
  log: { version: number; path: string }[];
};
export type DavReply = { status: number; body: string; headers?: Record<string, string> };

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/"';
const multistatus = (responses: string[], token?: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS}>${responses.join('')}${token === undefined ? '' : `<d:sync-token>${token}</d:sync-token>`}</d:multistatus>`;
const ok = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const status = (href: string, code: number, text: string) => `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 ${code} ${text}</d:status></d:response>`;
const xml = (body: string, code = 207): DavReply => ({ status: code, body, headers: { 'content-type': 'application/xml; charset=utf-8' } });
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A one-VEVENT VCALENDAR (or several UIDs in one object, for the invalid-but-seen case). */
export function event(...uids: string[]): string {
  const events = uids.flatMap((uid) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', 'DTSTART:20261201T100000Z', 'DTEND:20261201T110000Z', `SUMMARY:${uid}`, 'END:VEVENT']);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fixture//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

export class DavFixture {
  readonly home = '/u/cals/';
  readonly collections = new Map<string, Collection>();
  version = 1;
  /** Every request, as `METHOD path [report]`. */
  readonly requests: string[] = [];
  /** Knobs: answer every request with this status; omit ctags; truncate sync answers after N entries; drop these paths from multigets. */
  readonly quirks: { status?: number; challenge?: string; noCtag?: boolean; truncateAfter?: number; dropFromMultiget?: Set<string>; syncStatus?: number; malformed?: boolean } = {};

  collection(path: string, { name = path, color, components = ['VEVENT'], sync = true }: { name?: string; color?: string; components?: string[]; sync?: boolean } = {}): this {
    this.collections.set(path, { name, ...(color && { color }), components, reports: sync ? ['sync-collection', 'calendar-multiget'] : ['calendar-multiget'], objects: new Map(), log: [] });
    return this;
  }

  private of(path: string): [string, Collection] {
    const dir = path.replace(/[^/]*$/, '');
    const found = this.collections.get(dir);
    if (!found) throw new Error(`no collection for ${path}`);
    return [dir, found];
  }

  put(path: string, data: string): this {
    const [, c] = this.of(path);
    c.objects.set(path, { etag: `"${++this.version}"`, data });
    c.log.push({ version: this.version, path });
    return this;
  }

  remove(path: string): this {
    const [, c] = this.of(path);
    c.objects.delete(path);
    c.log.push({ version: ++this.version, path });
    return this;
  }

  handle(method: string, url: URL, depth: string | null, body: string): DavReply {
    const report = /<[\w:]*(sync-collection|calendar-multiget|calendar-query)\b/.exec(body)?.[1];
    this.requests.push([method, url.pathname, report].filter(Boolean).join(' '));
    if (this.quirks.status) return { status: this.quirks.status, body: 'no', headers: this.quirks.challenge ? { 'www-authenticate': this.quirks.challenge } : {} };
    if (this.quirks.malformed) return xml('<d:multistatus xmlns:d="DAV:"><d:response><d:href>');
    const path = url.pathname;

    if (method === 'PROPFIND') {
      if (path === '/.well-known/caldav') return xml(multistatus([ok('/', '<d:current-user-principal><d:href>/u/</d:href></d:current-user-principal>')]));
      if (path === '/u/') return xml(multistatus([ok('/u/', `<c:calendar-home-set><d:href>${this.home}</d:href></c:calendar-home-set>`)]));
      if (path === this.home && depth === '1') {
        return xml(
          multistatus([
            ok(this.home, '<d:resourcetype><d:collection/></d:resourcetype>'),
            ...[...this.collections].map(([href, c]) =>
              ok(
                href,
                `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${escape(c.name)}</d:displayname>${c.color ? `<ca:calendar-color>${c.color}</ca:calendar-color>` : ''}` +
                  `<c:calendar-timezone>BEGIN:VCALENDAR&#13;\nBEGIN:VTIMEZONE&#13;\nTZID:Europe/Berlin&#13;\nEND:VTIMEZONE&#13;\nEND:VCALENDAR</c:calendar-timezone>` +
                  `<c:supported-calendar-component-set>${c.components.map((n) => `<c:comp name="${n}"/>`).join('')}</c:supported-calendar-component-set>` +
                  `<d:supported-report-set>${c.reports.map((r) => `<d:supported-report><d:report><${r.startsWith('sync') ? 'd' : 'c'}:${r}/></d:report></d:supported-report>`).join('')}</d:supported-report-set>`,
              ),
            ),
          ]),
        );
      }
      const [dir, c] = this.of(path);
      if (depth === '0') return xml(multistatus([ok(dir, this.quirks.noCtag ? '' : `<cs:getctag>"${Math.max(0, ...c.log.map((l) => l.version))}"</cs:getctag>`)]));
      return xml(multistatus([ok(dir, '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'), ...[...c.objects].map(([href, o]) => ok(href, `<d:getetag>${escape(o.etag)}</d:getetag><d:resourcetype/>`))]));
    }

    if (method === 'REPORT' && report === 'sync-collection') {
      const [dir, c] = this.of(path);
      if (!c.reports.includes('sync-collection')) return { status: 501, body: 'not implemented' };
      if (this.quirks.syncStatus) return { status: this.quirks.syncStatus, body: 'refused' };
      const token = /<[\w:]*sync-token>([^<]*)</.exec(body)?.[1] ?? '';
      const since = token === '' ? 0 : Number(/^tok-(\d+)$/.exec(token)?.[1] ?? NaN);
      if (Number.isNaN(since)) return xml(`<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`, 403);
      // Each changed path at its latest version, oldest first, so a truncated answer's token resumes exactly.
      const latest = new Map<string, number>();
      for (const l of c.log) if (l.version > since && (since > 0 || c.objects.has(l.path))) latest.set(l.path, l.version);
      const changed = [...latest].sort((a, b) => a[1] - b[1]);
      const limit = this.quirks.truncateAfter;
      const truncated = limit !== undefined && changed.length > limit;
      const page = truncated ? changed.slice(0, limit) : changed;
      const upTo = truncated ? (page.at(-1)?.[1] ?? since) : this.version;
      const rows = page.map(([href]) => {
        const o = c.objects.get(href);
        return o ? ok(href, `<d:getetag>${escape(o.etag)}</d:getetag>`) : status(href, 404, 'Not Found');
      });
      if (truncated) rows.push(status(dir, 507, 'Insufficient Storage'));
      return xml(multistatus(rows, `tok-${upTo}`));
    }

    if (method === 'REPORT' && report === 'calendar-multiget') {
      const [, c] = this.of(path);
      const hrefs = [...body.matchAll(/<[\w:]*href>([^<]*)</g)].map((m) => m[1] ?? '');
      const rows = hrefs.flatMap((href) => {
        if (this.quirks.dropFromMultiget?.has(href)) return [];
        const o = c.objects.get(href);
        return [o ? ok(href, `<d:getetag>${escape(o.etag)}</d:getetag><c:calendar-data>${escape(o.data)}</c:calendar-data>`) : status(href, 404, 'Not Found')];
      });
      return xml(multistatus(rows));
    }
    return { status: 405, body: 'method not allowed' };
  }

  /** The fixture as the guarded transport, answering every host. */
  asGuardedFetch(): GuardedFetch {
    return async (req) => {
      const url = new URL(req.url);
      const reply = this.handle(req.method ?? 'GET', url, req.headers?.depth ?? null, req.body ?? '');
      return { status: reply.status, headers: new Headers(reply.headers), body: new TextEncoder().encode(reply.body), finalUrl: url.href };
    };
  }
}

export const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/** An adapter context over `fetch` with CalDAV credentials for `https://dav.test/`. */
export function davContext(fetch: GuardedFetch, credentials: ProviderCredentials = { provider: 'caldav', serverUrl: 'https://dav.test/', username: 'u', password: 'p' }): AdapterContext {
  return { fetch, credentials, saveCredentials: async () => {}, log: noopLog, signal: new AbortController().signal };
}

/** Drains an async iterable. */
export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}
