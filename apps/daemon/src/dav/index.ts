/**
 * CalDAV for published feeds and hosted calendars. Credentials resolve through the control role;
 * each request then uses one tenant transaction. Shared handlers read CollectionView; only device
 * logins can enter the hosted write path. Listings fetch metadata without rendering payloads.
 */
import { assertIanaZone, freeBusy, MAX_OBJECT_BYTES, propertyLine, vtimezoneFor, type JCalComponent } from '@supercal/core';
import { Temporal } from '@js-temporal/polyfill';
import { sourceCalendar, sourceObject, resourcesIn, withTenant, type SecretBox, type TenantTx } from '@supercal/db';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { and, eq } from 'drizzle-orm';
import { audit, ProblemError } from '../api/kit/index.ts';
import { requireAccess, atLeast } from '../hosted/access.ts';
import { membership, type Principal } from '../auth/principal.ts';
import { createFeedService } from '../feeds/service.ts';
import { createCalendar, deleteCalendar, getOrCreateHostedAccount } from '../hosted/calendars.ts';
import { deleteObject, HostedWriteError, lockHostedCalendar, writeObject, type HostedWriteCode } from '../hosted/objects.ts';
import type { Bus } from '../bus.ts';
import { createFeedAuth } from './auth.ts';
import { collectionProps, homeProps, objectProps, principalProps, propResponse, rootProps, statusResponse, wanted, type Account } from './props.ts';
import { loadAccount, loadUserAccount, loginByUsername, publicationCollection, type CollectionView } from './store.ts';
import { NS, child, children, esc, is, parseXml, xmlWriter, type XmlEl } from './xml.ts';

export type DavDeps = {
  secrets: SecretBox;
  /** Invalidates cached feed and device credentials across replicas. */
  bus: Pick<Bus, 'on'>;
  /** `SUPERCAL_PUBLIC_URL`; its host goes into sync tokens. Without it, the request's Host is used. */
  publicUrl?: string | undefined;
};

const DAV_HEADER = '1, 3, calendar-access';
const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8', DAV: DAV_HEADER };
const READ_METHODS = ['OPTIONS', 'PROPFIND', 'REPORT', 'GET', 'HEAD'];
const WRITE_METHODS = ['PUT', 'DELETE', 'POST', 'PROPPATCH', 'MKCALENDAR', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'UNLOCK'];
/** sync-collection without `<d:limit>` still answers in one page; this only bounds a runaway. */
const SYNC_PAGE_MAX = 1_000_000;

type Node =
  | { kind: 'root'; path: string }
  | { kind: 'principal'; path: string }
  | { kind: 'home'; path: string }
  | { kind: 'missing-collection'; path: string; segment: string }
  | { kind: 'collection'; path: string; view: CollectionView }
  | { kind: 'object'; path: string; view: CollectionView; name: string };

type Request = { tx: TenantTx; principal: Principal | null; collections: CollectionView[]; dav: Account; node: Node; collectionPath: (view: CollectionView) => string };

const davError = (status: 400 | 403 | 507, condition: string) =>
  new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:cal="${NS.CALDAV}"><${condition}/></d:error>`, {
    status,
    headers: XML_HEADERS,
  });

const notFound = () => new Response('not found', { status: 404 });

/** The node a request path names, `forbidden` for another login's tree, or null. */
function resolve(usernameOfLogin: string, collections: CollectionView[], path: string): Node | 'forbidden' | null {
  let segments: string[];
  try {
    segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [dav, username, cal, slug, name, ...rest] = segments;
  if (dav === undefined) return { kind: 'root', path: '/' };
  if (dav !== 'dav' || rest.length) return null;
  if (username === undefined) return { kind: 'root', path: '/dav/' };
  if (username !== usernameOfLogin) return 'forbidden';
  const principal = `/dav/${username}/`;
  if (cal === undefined) return { kind: 'principal', path: principal };
  if (cal !== 'cal') return null;
  if (slug === undefined) return { kind: 'home', path: `${principal}cal/` };
  if (!slug || slug.includes('/') || slug === '.' || slug === '..') return null;
  const view = collections.find((p) => p.segment === slug);
  const collection = `${principal}cal/${encodeURIComponent(slug)}/`;
  if (!view) return name === undefined ? { kind: 'missing-collection', path: collection, segment: slug } : null;
  if (name === undefined) return { kind: 'collection', path: collection, view };
  return { kind: 'object', path: collection + encodeURIComponent(name), view, name };

}

/** `[from, to)` of the VEVENT comp-filter's time-range; `null` when the query filters on another component. */
function queryRange(report: XmlEl): { from: Date; to: Date } | undefined | null {
  const vcalendar = child(child(report, NS.CALDAV, 'filter'), NS.CALDAV, 'comp-filter');
  const filters = children(vcalendar, NS.CALDAV, 'comp-filter');
  if (!filters.length) return undefined;
  const vevent = filters.find((f) => f.attrs['name']?.toUpperCase() === 'VEVENT');
  if (!vevent) return null;
  const range = child(vevent, NS.CALDAV, 'time-range');
  if (!range) return undefined;
  const instant = (value: string | undefined, fallback: string) => {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value ?? '');
    return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}Z`) : new Date(fallback);
  };
  return { from: instant(range.attrs['start'], '0001-01-01T00:00:00Z'), to: instant(range.attrs['end'], '9999-12-31T00:00:00Z') };
}



/** Protocol conditions for every service rejection, checked exhaustively when the service grows. */
const WRITE_ERRORS = {
  'invalid-calendar-data': { status: 403, condition: 'cal:valid-calendar-data' },
  'unsupported-component': { status: 403, condition: 'cal:supported-calendar-component' },
  'invalid-object': { status: 403, condition: 'cal:valid-calendar-object-resource' },
  'too-large': { status: 403, condition: 'cal:max-resource-size' },
  'uid-conflict': { status: 403, condition: 'cal:no-uid-conflict' },
  quota: { status: 507, condition: 'd:quota-not-exceeded' },
  'precondition-failed': { status: 412, condition: null },
  'not-found': { status: 404, condition: null },
} as const satisfies Record<HostedWriteCode, { status: number; condition: string | null }>;

/** Calendar metadata uses VTIMEZONE, generated once per zone and year without loading events. */
const timezoneCache = new Map<string, string>();
function calendarTimezone(zone: string): string {
  const year = new Date().getUTCFullYear();
  const key = `${zone}/${year}`;
  const cached = timezoneCache.get(key);
  if (cached) return cached;
  const component = (c: JCalComponent): string => [`BEGIN:${c[0].toUpperCase()}`, ...c[1].map(propertyLine), ...c[2].map(component), `END:${c[0].toUpperCase()}`].join('\r\n');
  const tz = vtimezoneFor(zone, { from: Temporal.Instant.from(`${year - 1}-01-01T00:00:00Z`), to: Temporal.Instant.from(`${year + 3}-01-01T00:00:00Z`) });
  const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Supercal//EN\r\n${component(tz)}\r\nEND:VCALENDAR\r\n`;
  timezoneCache.set(key, text);
  return text;
}

type Metadata = { name?: string; color?: string | null; sortOrder?: number; description?: string | null; timezone?: string };
/** Validate the entire property instruction before any changes; PROPPATCH sets are atomic. */
function metadataProperties(body: XmlEl | undefined, creating: boolean) {
  const entries = (body?.children ?? []).flatMap((operation) => {
    const props = child(operation, NS.DAV, 'prop');
    return (props?.children ?? []).map((prop) => ({ prop, remove: is(operation, NS.DAV, 'remove'), set: is(operation, NS.DAV, 'set') }));
  });
  const values: Metadata = {};
  const failed = new Set<XmlEl>();
  for (const { prop, remove, set } of entries) {
    const { ns, name, text } = prop;
    if (!set && !remove) { failed.add(prop); continue; }
    if (ns === NS.DAV && name === 'displayname' && !remove && text.length > 0 && text.length <= 100) values.name = text;
    else if (ns === NS.APPLE && name === 'calendar-color' && (remove || /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text))) values.color = remove ? null : text.slice(0, 7).toLowerCase();
    else if (ns === NS.APPLE && name === 'calendar-order' && (remove || /^-?\d+$/.test(text)) && Number.isSafeInteger(Number(text)) && Number(text) >= -2147483648 && Number(text) <= 2147483647) values.sortOrder = remove ? 0 : Number(text);
    else if (ns === NS.CALDAV && name === 'calendar-description' && text.length <= 10000) values.description = remove ? null : text;
    else if (ns === NS.CALDAV && name === 'calendar-timezone' && !remove) {
      const zone = /^TZID(?:;[^:]*)?:(.+)$/im.exec(text.replace(/\r?\n[ \t]/g, ''))?.[1]?.trim();
      try {
        if (!zone || !/^BEGIN:VTIMEZONE$/im.test(text)) throw new Error('Expected VTIMEZONE');
        assertIanaZone(zone);
        values.timezone = zone;
      } catch { failed.add(prop); }
    } else if (creating && ns === NS.CALDAV && name === 'supported-calendar-component-set' && !remove && prop.children.length === 1 && prop.children[0]?.attrs.name === 'VEVENT') {
      // A client may explicitly request the only component this server supports.
    } else failed.add(prop);
  }
  return { entries, values, failed };
}

/** Builds the CalDAV routes. */
export function createDav({ secrets, bus, publicUrl }: DavDeps) {
  const feedAuth = createFeedAuth(loginByUsername);
  bus.on('feed-credentials-rotated', ({ feedId }) => feedAuth.forget(feedId));
  bus.on('dav-login-revoked', ({ loginId }) => feedAuth.forget(loginId));
  const feeds = createFeedService(secrets);
  const tokenHost = publicUrl ? new URL(publicUrl).host : undefined;

  /** Authenticates, opens the tenant transaction, resolves the path and runs `handle`. */
  async function inLogin(c: Context, handle: (r: Request) => Promise<Response>): Promise<Response> {
    let ip = 'unknown';
    try {
      ip = getConnInfo(c).remote.address ?? ip;
    } catch {
      // Not served by Bun.serve (app.request in tests): no peer address.
    }
    const result = await feedAuth.authenticate(c.req.header('Authorization'), ip);
    const unauthorized = () => c.body('authentication required', 401, { 'WWW-Authenticate': 'Basic realm="Supercal", charset="UTF-8"' });
    if (!result.ok)
      return result.status === 429 ? c.body('too many failed logins', 429, { 'Retry-After': String(result.retryAfter ?? 300) }) : unauthorized();
    const { login } = result;
    const host = tokenHost ?? c.req.header('Host') ?? 'localhost';
    // Buffer a device's write body now (Hono caches it), so a slow upload holds no connection or calendar lock.
    if (login.kind === 'user' && WRITE_METHODS.includes(c.req.method)) await c.req.text();

    return withTenant(login.tenantId, async (tx) => {
      let principal: Principal | null = null;
      let collections: CollectionView[];
      let username: string;
      let displayName: string;
      let email: string | null;
      if (login.kind === 'feed') {
        const account = await loadAccount(tx, secrets, login.id);
        if (!account || account.feed.caldavPasswordHash !== login.passwordHash) {
          feedAuth.forget(login.id);
          return unauthorized();
        }
        collections = account.publications.map((pub) => publicationCollection(pub, host));
        username = account.feed.caldavUsername;
        displayName = account.feed.name;
        email = account.ownerEmail;
      } else {
        const current = await membership(login.userId, login.tenantId);
        principal = current ? { kind: 'user', via: 'davLogin', userId: login.userId, tenantId: login.tenantId, ...current } : null;
        const account = principal && await loadUserAccount(tx, login.id, host, principal);
        if (!account || account.login.passwordHash !== login.passwordHash || account.login.userId !== login.userId) {
          feedAuth.forget(login.id);
          return unauthorized();
        }
        collections = account.collections;
        username = account.login.username;
        displayName = account.login.name;
        email = account.ownerEmail;
      }
      if ((!principal && WRITE_METHODS.includes(c.req.method)) || ['MOVE', 'COPY', 'LOCK', 'UNLOCK', 'MKCOL', 'POST'].includes(c.req.method)) return davError(403, 'd:need-privileges');
      const node = resolve(username, collections, c.req.path);
      if (node === 'forbidden') return davError(403, 'd:need-privileges');
      if (!node) return notFound();
      const path = `/dav/${username}/`;
      const dav: Account = { principal: path, home: `${path}cal/`, displayName, email, writable: principal !== null };
      return handle({ tx, principal, collections, dav, node, collectionPath: (view) => `${dav.home}${encodeURIComponent(view.segment)}/` });
    }).catch((error: unknown) => {
      if (error instanceof HostedWriteError) {
        const mapped = WRITE_ERRORS[error.code];
        if (!mapped.condition) return new Response(null, { status: mapped.status });
        const conflict = error.code === 'uid-conflict' && error.conflictObjectName ? `<d:href>${esc(c.req.path.slice(0, c.req.path.lastIndexOf('/') + 1) + encodeURIComponent(error.conflictObjectName))}</d:href>` : '';
        return new Response(xmlWriter().document('d:error', `<${mapped.condition}>${conflict}</${mapped.condition}>`), { status: mapped.status, headers: XML_HEADERS });
      }
      if (error instanceof ProblemError && error.status === 403) return davError(403, 'd:need-privileges');
      if (error instanceof ProblemError && error.status === 404) return notFound();
      if (error instanceof ProblemError && error.slug === 'calendar-quota') return davError(507, 'd:quota-not-exceeded');
      throw error;
    });
  }

  const multistatus = (w: ReturnType<typeof xmlWriter>, body: string) => new Response(w.document('d:multistatus', body), { status: 207, headers: XML_HEADERS });

  async function propfind(c: Context, r: Request): Promise<Response> {
    const depth = c.req.header('Depth')?.trim().toLowerCase() ?? '0';
    if (depth === 'infinity') return davError(403, 'd:propfind-finite-depth');
    const raw = await c.req.text();
    const body = raw.trim() ? parseXml(raw) : undefined;
    if (raw.trim() && !is(body, NS.DAV, 'propfind')) return c.body('expected a DAV:propfind body', 400);
    const want = wanted(body);
    const w = xmlWriter();
    const { tx, node, dav } = r;
    const collection = (view: CollectionView, seq: bigint) => {
      const timezone = view.calendar && view.display.timezone ? calendarTimezone(view.display.timezone) : undefined;
      return propResponse(w, r.collectionPath(view), collectionProps(dav, { ...view.display, timezone: timezone ?? null, token: view.token(seq), ...(view.calendar && { maxResourceSize: MAX_OBJECT_BYTES }) }, view.privileges), want);
    };

    switch (node.kind) {
      case 'missing-collection': return notFound();
      case 'root':
        return multistatus(w, propResponse(w, node.path, rootProps(dav), want));
      case 'principal':
        return multistatus(w, propResponse(w, node.path, principalProps(dav), want));
      case 'home': {
        const parts = [propResponse(w, node.path, homeProps(dav), want)];
        if (depth === '1') for (const view of r.collections) parts.push(collection(view, (await view.index(tx)).maxSeq));
        return multistatus(w, parts.join(''));
      }
      case 'collection': {
        const index = await node.view.index(tx);
        const parts = [collection(node.view, index.maxSeq)];
        if (depth === '1') for (const e of index.byHref.values()) parts.push(propResponse(w, node.path + e.href, objectProps(e.etag), want));
        return multistatus(w, parts.join(''));
      }
      case 'object': {
        const entry = (await node.view.index(tx)).byHref.get(node.name);
        return entry ? multistatus(w, propResponse(w, node.path, objectProps(entry.etag), want)) : notFound();
      }
    }
  }

  async function report(c: Context, r: Request): Promise<Response> {
    const { tx, node } = r;
    if (node.kind !== 'collection') return davError(403, 'd:supported-report');
    const body = parseXml(await c.req.text());
    if (!body) return c.body('expected an XML report body', 400);
    const { view, path } = node;
    if (is(body, NS.CALDAV, 'free-busy-query')) {
      if (!r.principal || !view.calendar) return davError(403, 'd:supported-report');
      await requireAccess(tx, r.principal, view.calendar.id, 'free-busy');
      const ranges = children(body, NS.CALDAV, 'time-range');
      if (ranges.length !== 1) return c.body('expected exactly one time-range', 400);
      const range = ranges[0];
      const instant = (value: string | undefined) => {
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value ?? '');
        if (!m) throw new Error('Expected UTC DATE-TIME');
        return Temporal.Instant.from(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      };
      let from: Temporal.Instant, to: Temporal.Instant;
      try {
        from = instant(range?.attrs.start); to = instant(range?.attrs.end);
        if (Temporal.Instant.compare(from, to) >= 0) throw new Error('Invalid window');
      } catch { return c.body('expected a valid time-range with UTC start and end', 400); }
      const rows = await resourcesIn(tx, [view.calendar.id], { from: new Date(from.epochMilliseconds), to: new Date(to.epochMilliseconds) });
      const result = freeBusy(rows.map((row) => row.data), { from, to }, view.calendar.timezone ?? 'UTC');
      if (result.truncated) return davError(403, 'd:number-of-matches-within-limits');
      const stamp = (value: Temporal.Instant) => value.toString({ smallestUnit: 'second' }).replace(/[-:]/g, '');
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Supercal//EN', 'BEGIN:VFREEBUSY', `DTSTART:${stamp(from)}`, `DTEND:${stamp(to)}`, `DTSTAMP:${stamp(Temporal.Now.instant())}`,
        ...result.intervals.map((interval) => `FREEBUSY;FBTYPE=${interval.status === 'busy' ? 'BUSY' : 'BUSY-TENTATIVE'}:${stamp(interval.start)}/${stamp(interval.end)}`), 'END:VFREEBUSY', 'END:VCALENDAR', ''];
      return c.body(lines.join('\r\n'), 200, { 'Content-Type': 'text/calendar; charset=utf-8' });
    }
    const want = wanted(body);
    const w = xmlWriter();
    // Rendered objects carry the index's ETag, so a listing and a report agree.
    const index = is(body, NS.DAV, 'sync-collection') ? undefined : await view.index(tx);
    const object = (uid: string, ics: string) => {
      const entry = index?.byUid.get(uid);
      return entry ? propResponse(w, path + entry.href, objectProps(entry.etag, ics), want) : '';
    };

    if (is(body, NS.CALDAV, 'calendar-query')) {
      const range = queryRange(body);
      if (range === null) return multistatus(w, '');
      const rendered = await view.query(tx, range);
      return multistatus(w, [...rendered].map(([uid, o]) => object(uid, o.ics)).join(''));
    }

    if (is(body, NS.CALDAV, 'calendar-multiget')) {
      const requested = children(body, NS.DAV, 'href').map((h) => {
        const pathname = URL.parse(h.text, 'http://x')?.pathname ?? '';
        let name = '';
        try { name = pathname.startsWith(path) ? decodeURIComponent(pathname.slice(path.length)) : ''; } catch {}
        return { href: h.text, entry: index?.byHref.get(name) };
      });
      const rendered = await view.objects(tx, requested.flatMap((q) => (q.entry ? [q.entry.uid] : [])));
      return multistatus(
        w,
        requested
          .map(({ href, entry }) => {
            const o = entry && rendered.get(entry.uid);
            return o ? object(entry.uid, o.ics) : statusResponse(href, '404 Not Found');
          })
          .join(''),
      );
    }

    if (is(body, NS.DAV, 'sync-collection')) {
      const tokenText = child(body, NS.DAV, 'sync-token')?.text.trim() ?? '';
      let since = 0n;
      if (tokenText) {
        const parsed = await view.parseToken(tx, tokenText);
        if (parsed === null) return davError(403, 'd:valid-sync-token');
        since = parsed;
      }
      const nresults = Number(child(child(body, NS.DAV, 'limit'), NS.DAV, 'nresults')?.text);
      const limit = Number.isInteger(nresults) && nresults > 0 ? nresults : SYNC_PAGE_MAX;
      const page = await view.changes(tx, since, limit);
      const wantsData = want !== 'all' && want.some((p) => p.ns === NS.CALDAV && p.name === 'calendar-data');
      const rendered = wantsData ? await view.objects(tx, page.rows.filter((row) => row.alive).map((row) => row.uid)) : undefined;
      const parts: string[] = [];
      for (const row of page.rows) {
        const href = path + row.href;
        if (row.alive) {
          const ics = rendered?.get(row.uid)?.ics;
          if (rendered && ics === undefined) parts.push(statusResponse(href, '404 Not Found'));
          else parts.push(propResponse(w, href, objectProps(row.etag, ics), want));
        } else if (since > 0n) parts.push(statusResponse(href, '404 Not Found'));
      }
      if (page.hasMore) parts.push(statusResponse(path, '507 Insufficient Storage'));
      return multistatus(w, `${parts.join('')}<d:sync-token>${esc(view.token(page.maxSeq))}</d:sync-token>`);
    }

    return davError(403, 'd:supported-report');
  }

  async function get(c: Context, r: Request): Promise<Response> {
    const { tx, node } = r;
    if (node.kind !== 'object') return notFound();
    const entry = (await node.view.index(tx)).byHref.get(node.name);
    if (!entry) return notFound();
    if (c.req.header('If-None-Match') === entry.etag) return c.body(null, 304, { ETag: entry.etag });
    const object = (await node.view.objects(tx, [entry.uid])).get(entry.uid);
    if (!object) return notFound();
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8', ETag: entry.etag };
    return c.req.method === 'HEAD' ? c.body(null, 200, headers) : c.body(object.ics, 200, headers);
  }

  async function write(c: Context, r: Request): Promise<Response> {
    const { node, tx, principal } = r;
    if (!principal) return davError(403, 'd:need-privileges');
    if (c.req.method === 'MKCALENDAR') {
      if (node.kind === 'collection') return davError(403, 'd:resource-must-be-null');
      if (node.kind !== 'missing-collection' || !c.req.path.endsWith('/')) return davError(403, 'd:need-privileges');
      if (node.segment.startsWith('cal_')) return davError(403, 'd:need-privileges');
      const raw = await c.req.text();
      const body = raw.trim() ? parseXml(raw) : undefined;
      if (raw.trim() && !is(body, NS.CALDAV, 'mkcalendar')) return c.body('expected a CalDAV:mkcalendar body', 400);
      const parsed = metadataProperties(body, true);
      if (parsed.failed.size) return davError(403, 'd:cannot-modify-protected-property');
      const account = await getOrCreateHostedAccount(tx, principal.userId);
      const [existing] = await tx.select({ id: sourceCalendar.id }).from(sourceCalendar)
        .where(and(eq(sourceCalendar.accountId, account.id), eq(sourceCalendar.providerCalendarId, node.segment)));
      if (existing) return davError(403, 'd:resource-must-be-null');
      const { name = node.segment, color, description, timezone, sortOrder } = parsed.values;
      const calendar = await createCalendar(tx, feeds, principal.userId, { name, ...(color && { color }), ...(description != null && { description }), ...(timezone && { timezone }) });
      await tx.update(sourceCalendar).set({ providerCalendarId: node.segment, ...(sortOrder !== undefined && { sortOrder }) }).where(eq(sourceCalendar.id, calendar.id));
      await audit(tx, principal, 'calendar.create', { type: 'calendar', id: calendar.id });
      return c.body(null, 201);
    }
    if (node.kind !== 'object' && node.kind !== 'collection') return davError(403, 'd:need-privileges');
    const calendar = node.view.calendar;
    if (!calendar || node.view.privileges === 'read') return davError(403, 'd:need-privileges');
    // Recheck the grant after the write lock, including concurrent revocation and deletion.
    await lockHostedCalendar(tx, calendar.id);
    const { calendar: active, access } = await requireAccess(tx, principal, calendar.id, 'write');
    if (active.state !== 'active') return notFound();
    const ifMatch = c.req.header('If-Match');
    if (node.kind === 'object') {
      if (!node.name.endsWith('.ics') || node.name.includes('/') || Buffer.byteLength(node.name) > 255) return davError(403, 'd:need-privileges');
      if (c.req.method === 'PUT') {
        if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'text/calendar') return davError(403, 'cal:supported-calendar-data');
        const result = await writeObject(tx, calendar, { objectName: node.name, payload: await c.req.text(), ...(ifMatch !== undefined && { ifMatch }), ...(c.req.header('If-None-Match') === '*' && { ifNoneMatch: '*' }) });
        await audit(tx, principal, result.created ? 'event.create' : 'event.update', { type: 'calendar', id: calendar.id }, { uid: result.uid });
        return c.body(null, result.created ? 201 : 204, { ETag: result.etag });
      }
      if (c.req.method === 'DELETE') {
        const [object] = await tx.select({ uid: sourceObject.groupUid }).from(sourceObject)
          .where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, node.name)));
        if (object) await audit(tx, principal, 'event.delete', { type: 'calendar', id: calendar.id }, { uid: object.uid });
        await deleteObject(tx, calendar, { objectName: node.name, ...(ifMatch !== undefined && { ifMatch }) });
        return c.body(null, 204);
      }
    } else {
      if (c.req.method === 'DELETE') {
        if (node.view.shared) return davError(403, 'd:need-privileges');
        await requireAccess(tx, principal, calendar.id, 'owner');
        await deleteCalendar(tx, feeds, calendar.id);
        await audit(tx, principal, 'calendar.delete', { type: 'calendar', id: calendar.id });
        return c.body(null, 204);
      }
      if (c.req.method === 'PROPPATCH') {
        const body = parseXml(await c.req.text());
        if (!is(body, NS.DAV, 'propertyupdate')) return c.body('expected a DAV:propertyupdate body', 400);
        const { entries, values, failed } = metadataProperties(body, false);
        if (!atLeast(access, 'manage')) for (const { prop } of entries) failed.add(prop);
        if (!entries.length) return c.body('expected properties', 400);
        if (!failed.size) {
          await tx.update(sourceCalendar).set({ ...values, updatedAt: new Date() }).where(eq(sourceCalendar.id, calendar.id));
          await audit(tx, principal, 'calendar.update', { type: 'calendar', id: calendar.id });
        }
        const w = xmlWriter();
        const stats = entries.map(({ prop }) => {
          const q = w.qname(prop.ns, prop.name);
          const status = failed.has(prop) ? '403 Forbidden' : failed.size ? '424 Failed Dependency' : '200 OK';
          return `<d:propstat><d:prop><${q}/></d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`;
        }).join('');
        return multistatus(w, `<d:response><d:href>${esc(node.path)}</d:href>${stats}</d:response>`);
      }
    }
    return davError(403, 'd:need-privileges');
  }

  const app = new Hono();
  app.all('/.well-known/caldav', (c) => c.redirect('/dav/', 301));
  app.on('OPTIONS', ['/dav', '/dav/*'], (c) => {
    if (!c.req.header('Authorization')) return c.body(null, 200, { DAV: DAV_HEADER, Allow: READ_METHODS.join(', ') });
    return inLogin(c, async (r) => c.body(null, 200, { DAV: DAV_HEADER, Allow: [...READ_METHODS, ...(r.principal ? ['PUT', 'DELETE', 'MKCALENDAR', 'PROPPATCH'] : [])].join(', ') }));
  });
  app.on('PROPFIND', ['/', '/dav', '/dav/*'], (c) => inLogin(c, (r) => propfind(c, r)));
  app.on('REPORT', '/dav/*', (c) => inLogin(c, (r) => report(c, r)));
  app.on(['GET', 'HEAD'], '/dav/*', (c) => inLogin(c, (r) => get(c, r)));
  app.on(WRITE_METHODS, ['/dav', '/dav/*'], (c) => inLogin(c, (r) => write(c, r)));
  return app;
}
