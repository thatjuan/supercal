/**
 * The read-only CalDAV server (architecture §9), mounted at the root by the `dav` role. One feed
 * login is one account; each enabled publication is a calendar collection:
 *
 *   /.well-known/caldav                        301 → /dav/
 *   /, /dav/                                   PROPFIND answers current-user-principal
 *   /dav/<username>/                           principal
 *   /dav/<username>/cal/                       calendar home
 *   /dav/<username>/cal/<pubSlug>/             collection
 *   /dav/<username>/cal/<pubSlug>/<href>.ics   object
 *
 * The login lookup runs as `supercal_control`; the rest of a request runs in one `withTenant`
 * transaction. Listings never render: ETags and hrefs come from `pubIndex`.
 */
import { hrefFor, objectEtag } from '@supercal/core';
import { changesSince, resourcesByUids, resourcesIn, tombstoneFloor, withTenant, type SecretBox, type TenantTx } from '@supercal/db';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import type { Bus } from '../bus.ts';
import { createFeedAuth } from './auth.ts';
import { collectionProps, homeProps, objectProps, principalProps, propResponse, rootProps, statusResponse, wanted, type Account } from './props.ts';
import { loadAccount, loginByUsername, pubIndex, render, renderUids, type FeedAccount, type Pub } from './store.ts';
import { NS, child, children, esc, is, parseXml, xmlWriter, type XmlEl } from './xml.ts';

export type DavDeps = {
  secrets: SecretBox;
  /** Delivers `feed-credentials-rotated`, which drops cached logins of the feed. */
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
  | { kind: 'collection'; path: string; pub: Pub }
  | { kind: 'object'; path: string; pub: Pub; name: string };

type Request = { tx: TenantTx; account: FeedAccount; dav: Account; node: Node; collectionPath: (pub: Pub) => string; token: (pub: Pub, seq: bigint) => string };

const davError = (status: 400 | 403, condition: string) =>
  new Response(`<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:cal="${NS.CALDAV}"><${condition}/></d:error>`, {
    status,
    headers: XML_HEADERS,
  });

const notFound = () => new Response('not found', { status: 404 });

/** The node a request path names, `forbidden` for another login's tree, or null. */
function resolve(account: FeedAccount, path: string): Node | 'forbidden' | null {
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
  if (username !== account.feed.caldavUsername) return 'forbidden';
  const principal = `/dav/${username}/`;
  if (cal === undefined) return { kind: 'principal', path: principal };
  if (cal !== 'cal') return null;
  if (slug === undefined) return { kind: 'home', path: `${principal}cal/` };
  const pub = account.publications.find((p) => p.slug === slug);
  if (!pub) return null;
  const collection = `${principal}cal/${slug}/`;
  if (name === undefined) return { kind: 'collection', path: collection, pub };
  return name.endsWith('.ics') ? { kind: 'object', path: collection + name, pub, name } : null;
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

const TOKEN = /^https?:\/\/[^/]+\/ns\/sync\/([^/]+)\/(\d+)\/(\d+)$/;

/** Builds the CalDAV routes. */
export function createDav({ secrets, bus, publicUrl }: DavDeps) {
  const feedAuth = createFeedAuth(loginByUsername);
  bus.on('feed-credentials-rotated', ({ feedId }) => feedAuth.forgetFeed(feedId));
  const tokenHost = publicUrl ? new URL(publicUrl).host : undefined;

  /** Authenticates, opens the tenant transaction, resolves the path and runs `handle`. */
  async function inFeed(c: Context, handle: (r: Request) => Promise<Response>): Promise<Response> {
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

    return withTenant(login.tenantId, async (tx) => {
      const account = await loadAccount(tx, secrets, login.feedId);
      if (!account || account.feed.caldavPasswordHash !== login.passwordHash) {
        feedAuth.forgetFeed(login.feedId);
        return unauthorized();
      }
      const node = resolve(account, c.req.path);
      if (node === 'forbidden') return davError(403, 'd:need-privileges');
      if (!node) return notFound();
      const principal = `/dav/${account.feed.caldavUsername}/`;
      const dav: Account = { principal, home: `${principal}cal/`, displayName: account.feed.name, email: account.ownerEmail };
      return handle({
        tx,
        account,
        dav,
        node,
        collectionPath: (pub) => `${dav.home}${pub.slug}/`,
        token: (pub, seq) => `https://${host}/ns/sync/${pub.id}/${pub.epoch}/${seq}`,
      });
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
    const collection = (pub: Pub, seq: bigint) =>
      propResponse(w, r.collectionPath(pub), collectionProps(dav, { name: pub.name, color: pub.color, sortOrder: pub.sortOrder, token: r.token(pub, seq) }), want);

    switch (node.kind) {
      case 'root':
        return multistatus(w, propResponse(w, node.path, rootProps(dav), want));
      case 'principal':
        return multistatus(w, propResponse(w, node.path, principalProps(dav), want));
      case 'home': {
        const parts = [propResponse(w, node.path, homeProps(dav), want)];
        if (depth === '1') for (const pub of r.account.publications) parts.push(collection(pub, (await pubIndex(tx, pub)).maxSeq));
        return multistatus(w, parts.join(''));
      }
      case 'collection': {
        const index = await pubIndex(tx, node.pub);
        const parts = [collection(node.pub, index.maxSeq)];
        if (depth === '1') for (const e of index.byHref.values()) parts.push(propResponse(w, node.path + e.href, objectProps(e.etag), want));
        return multistatus(w, parts.join(''));
      }
      case 'object': {
        const entry = (await pubIndex(tx, node.pub)).byHref.get(node.name);
        return entry ? multistatus(w, propResponse(w, node.path, objectProps(entry.etag), want)) : notFound();
      }
    }
  }

  async function report(c: Context, r: Request): Promise<Response> {
    const { tx, node } = r;
    if (node.kind !== 'collection') return davError(403, 'd:supported-report');
    const body = parseXml(await c.req.text());
    if (!body) return c.body('expected an XML report body', 400);
    const { pub, path } = node;
    const want = wanted(body);
    const w = xmlWriter();
    // Rendered objects carry the index's ETag, so a listing and a report agree.
    const index = is(body, NS.DAV, 'sync-collection') ? undefined : await pubIndex(tx, pub);
    const object = (uid: string, ics: string) => {
      const entry = index?.byUid.get(uid);
      return entry ? propResponse(w, path + entry.href, objectProps(entry.etag, ics), want) : '';
    };

    if (is(body, NS.CALDAV, 'calendar-query')) {
      const range = queryRange(body);
      if (range === null) return multistatus(w, '');
      const rendered = await render(pub, await resourcesIn(tx, pub.sourceIds, range));
      return multistatus(w, [...rendered].map(([uid, o]) => object(uid, o.ics)).join(''));
    }

    if (is(body, NS.CALDAV, 'calendar-multiget')) {
      const requested = children(body, NS.DAV, 'href').map((h) => {
        const pathname = URL.parse(h.text, 'http://x')?.pathname ?? '';
        let decoded = pathname;
        try {
          decoded = decodeURIComponent(pathname);
        } catch {}
        const name = decoded.startsWith(path) ? decoded.slice(path.length) : '';
        return { href: h.text, entry: index?.byHref.get(name) };
      });
      const rendered = await renderUids(tx, pub, requested.flatMap((q) => (q.entry ? [q.entry.uid] : [])));
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
        const m = TOKEN.exec(tokenText);
        if (!m || m[1] !== pub.id || Number(m[2]) !== pub.epoch || BigInt(m[3] ?? 0) < (await tombstoneFloor(tx))) return davError(403, 'd:valid-sync-token');
        since = BigInt(m[3] ?? 0);
      }
      const nresults = Number(child(child(body, NS.DAV, 'limit'), NS.DAV, 'nresults')?.text);
      const limit = Number.isInteger(nresults) && nresults > 0 ? nresults : SYNC_PAGE_MAX;
      const page = await changesSince(tx, pub.sourceIds, since, limit);

      // Per UID: alive if any changed copy is alive, or (virtual) another source still holds it.
      const changed = new Map<string, { alive: boolean; seq: bigint }>();
      for (const row of page.rows) {
        const seen = changed.get(row.uid);
        changed.set(row.uid, { alive: (seen?.alive ?? false) || !row.deleted, seq: seen && seen.seq > row.seq ? seen.seq : row.seq });
      }
      const tombstoned = [...changed].filter(([, v]) => !v.alive).map(([uid]) => uid);
      const stillHeld = new Set(tombstoned.length ? (await resourcesByUids(tx, pub.sourceIds, tombstoned)).map((row) => row.uid) : []);
      const present = new Set([...changed.keys()].filter((uid) => changed.get(uid)?.alive || stillHeld.has(uid)));
      const wantsData = want !== 'all' && want.some((p) => p.ns === NS.CALDAV && p.name === 'calendar-data');
      const rendered = wantsData ? await renderUids(tx, pub, [...present]) : undefined;

      const parts: string[] = [];
      for (const [uid, { seq }] of changed) {
        const href = path + (await hrefFor(pub.spec, uid));
        if (present.has(uid)) {
          // A UID the projection hides has no body; answer it as gone when its data was asked for.
          const ics = rendered?.get(uid)?.ics;
          if (rendered && ics === undefined) parts.push(statusResponse(href, '404 Not Found'));
          else parts.push(propResponse(w, href, objectProps(await objectEtag(pub.spec, pub.epoch, uid, seq), ics), want));
        } else if (since > 0n) parts.push(statusResponse(href, '404 Not Found'));
      }
      if (page.hasMore) parts.push(statusResponse(path, '507 Insufficient Storage'));
      return multistatus(w, `${parts.join('')}<d:sync-token>${esc(r.token(pub, page.maxSeq))}</d:sync-token>`);
    }

    return davError(403, 'd:supported-report');
  }

  async function get(c: Context, r: Request): Promise<Response> {
    const { tx, node } = r;
    if (node.kind !== 'object') return notFound();
    const entry = (await pubIndex(tx, node.pub)).byHref.get(node.name);
    if (!entry) return notFound();
    if (c.req.header('If-None-Match') === entry.etag) return c.body(null, 304, { ETag: entry.etag });
    const object = (await renderUids(tx, node.pub, [entry.uid])).get(entry.uid);
    if (!object) return notFound();
    const headers = { 'Content-Type': 'text/calendar; charset=utf-8', ETag: entry.etag };
    return c.req.method === 'HEAD' ? c.body(null, 200, headers) : c.body(object.ics, 200, headers);
  }

  const app = new Hono();
  app.all('/.well-known/caldav', (c) => c.redirect('/dav/', 301));
  app.options('/dav/*', (c) => c.body(null, 200, { DAV: DAV_HEADER, Allow: READ_METHODS.join(', ') }));
  app.options('/dav', (c) => c.body(null, 200, { DAV: DAV_HEADER, Allow: READ_METHODS.join(', ') }));
  app.on('PROPFIND', ['/', '/dav', '/dav/*'], (c) => inFeed(c, (r) => propfind(c, r)));
  app.on('REPORT', '/dav/*', (c) => inFeed(c, (r) => report(c, r)));
  app.on(['GET', 'HEAD'], '/dav/*', (c) => inFeed(c, (r) => get(c, r)));
  // Read-only: clients treat 403 need-privileges as "no permission" and stop retrying.
  app.on(WRITE_METHODS, ['/dav', '/dav/*'], () => davError(403, 'd:need-privileges'));
  return app;
}
