// Minimal read-only CalDAV server (RFC 4791 + RFC 6578 sync-collection) on Hono.
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { renderObject, type EventResource } from "./model";
import { NS, child, children, esc, parseXml, qname, rootNsDecls, type XmlEl } from "./xml";
import {
  type Feed, type Publication, feedByUsername, formatToken, hrefName, outputUid, parseToken, pubState, publications, tombstoneFloor, view,
} from "./store";

type Env = { Variables: { feed: Feed } };
export const dav = new Hono<Env>();

const DAV_HEADER = "1, 3, calendar-access";
const XML = { "Content-Type": "application/xml; charset=utf-8", DAV: DAV_HEADER };

// Argon2 verify costs ~tens of ms and clients send Basic on every request: cache successes briefly.
const authCache = new Map<string, number>();
async function authenticate(header: string | undefined): Promise<Feed | null> {
  if (!header?.startsWith("Basic ")) return null;
  const [user = "", ...rest] = atob(header.slice(6)).split(":");
  const pass = rest.join(":");
  const feed = await feedByUsername(user);
  if (!feed) return null;
  const key = createHash("sha256").update(`${feed.password_hash}\0${pass}`).digest("hex");
  if ((authCache.get(key) ?? 0) > Date.now()) return feed;
  if (!(await Bun.password.verify(pass, feed.password_hash))) return null;
  authCache.set(key, Date.now() + 5 * 60_000);
  return feed;
}

// Clients often start discovery with PROPFIND / (caldav lib, DAVx5 with a bare host URL).
dav.use("*", async (c, next) => {
  const isDav = c.req.path.startsWith("/dav/") || c.req.path === "/dav" || (c.req.path === "/" && c.req.method === "PROPFIND");
  if (!isDav || c.req.method === "OPTIONS") return next();
  const feed = await authenticate(c.req.header("Authorization"));
  if (!feed) return c.body("auth required", 401, { "WWW-Authenticate": 'Basic realm="Supercal", charset="UTF-8"' });
  c.set("feed", feed);
  await next();
});

dav.get("/.well-known/caldav", (c) => c.redirect("/dav/", 301));
dav.on(["PROPFIND", "OPTIONS"], "/.well-known/caldav", (c) => c.redirect("/dav/", 301));

// ---- resource tree -------------------------------------------------------------------------
type Node =
  | { kind: "root"; href: string }
  | { kind: "principal"; href: string }
  | { kind: "home"; href: string }
  | { kind: "calendar"; href: string; pub: Publication }
  | { kind: "object"; href: string; pub: Publication; name: string };

const P = (feed: Feed) => ({
  principal: `/dav/principals/${encodeURIComponent(feed.username)}/`,
  home: `/dav/calendars/${encodeURIComponent(feed.username)}/`,
  cal: (p: Publication) => `/dav/calendars/${encodeURIComponent(feed.username)}/${p.slug}/`,
});

async function resolve(feed: Feed, path: string): Promise<Node | null> {
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent); // ["dav", ...]
  const paths = P(feed);
  if (seg.length <= 1) return { kind: "root", href: seg.length ? "/dav/" : "/" };
  if (seg[1] === "principals" && seg[2] === feed.username && seg.length === 3) return { kind: "principal", href: paths.principal };
  if (seg[1] !== "calendars" || seg[2] !== feed.username) return null;
  if (seg.length === 3) return { kind: "home", href: paths.home };
  const pub = (await publications(feed.id)).find((p) => p.slug === seg[3]);
  if (!pub) return null;
  if (seg.length === 4) return { kind: "calendar", href: paths.cal(pub), pub };
  if (seg.length === 5 && seg[4]?.endsWith(".ics")) return { kind: "object", href: paths.cal(pub) + seg[4], pub, name: seg[4] };
  return null;
}

// ---- objects -------------------------------------------------------------------------------
type Obj = { href: string; ics: string; etag: string };

function objectFor(feed: Feed, pub: Publication, r: EventResource): Obj | null {
  const outUid = outputUid(feed, pub, r.uid);
  const ics = renderObject(r, { privacy: pub.privacy, keepAlarms: pub.keep_alarms, outUid });
  if (!ics) return null;
  return { href: P(feed).cal(pub) + hrefName(outUid), ics, etag: `"${createHash("sha256").update(ics).digest("base64url").slice(0, 27)}"` };
}

async function allObjects(feed: Feed, pub: Publication, range?: [Date, Date]) {
  const v = await view(pub, { range });
  const objs: Obj[] = [];
  for (const r of v.items.values()) {
    if (!r) continue;
    const o = objectFor(feed, pub, r);
    if (o) objs.push(o);
  }
  return { token: v.token, objs };
}

// ---- properties ----------------------------------------------------------------------------
type PropVal = string | null; // inner XML, or null => 404
type Ctx = { feed: Feed; extra: Map<string, string> };

function propsFor(node: Node, ctx: Ctx, token?: string, obj?: Obj): Record<string, () => PropVal> {
  const paths = P(ctx.feed);
  const h = (u: string) => `<d:href>${esc(u)}</d:href>`;
  const common: Record<string, () => PropVal> = {
    [`${NS.DAV}|current-user-principal`]: () => h(paths.principal),
    [`${NS.DAV}|principal-collection-set`]: () => h("/dav/principals/"),
    [`${NS.DAV}|owner`]: () => h(paths.principal),
    [`${NS.DAV}|current-user-privilege-set`]: () => "<d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege>",
  };
  switch (node.kind) {
    case "root":
      return { ...common, [`${NS.DAV}|resourcetype`]: () => "<d:collection/>", [`${NS.DAV}|displayname`]: () => "Supercal" };
    case "principal":
      return {
        ...common,
        [`${NS.DAV}|resourcetype`]: () => "<d:principal/>",
        [`${NS.DAV}|displayname`]: () => esc(ctx.feed.username),
        [`${NS.DAV}|principal-URL`]: () => h(paths.principal),
        [`${NS.CALDAV}|calendar-home-set`]: () => h(paths.home),
        [`${NS.CALDAV}|calendar-user-address-set`]: () => h(`mailto:${ctx.feed.username}@feeds.supercal.invalid`) + h(paths.principal),
        [`${NS.DAV}|supported-report-set`]: () => "",
      };
    case "home":
      return { ...common, [`${NS.DAV}|resourcetype`]: () => "<d:collection/>", [`${NS.DAV}|displayname`]: () => "Calendars" };
    case "calendar": {
      const pub = node.pub;
      return {
        ...common,
        [`${NS.DAV}|resourcetype`]: () => "<d:collection/><cal:calendar/>",
        [`${NS.DAV}|displayname`]: () => esc(pub.name),
        [`${NS.APPLE}|calendar-color`]: () => esc(pub.color),
        [`${NS.APPLE}|calendar-order`]: () => String(pub.sort_order),
        [`${NS.CALDAV}|calendar-description`]: () => esc(`${pub.kind} · ${pub.privacy} · read-only`),
        [`${NS.CALDAV}|supported-calendar-component-set`]: () => '<cal:comp name="VEVENT"/>',
        [`${NS.CALDAV}|supported-calendar-data`]: () => '<cal:calendar-data content-type="text/calendar" version="2.0"/>',
        [`${NS.CALDAV}|schedule-calendar-transp`]: () => "<cal:opaque/>",
        [`${NS.CS}|getctag`]: () => (token ? esc(token) : null),
        [`${NS.DAV}|sync-token`]: () => (token ? esc(token) : null),
        [`${NS.DAV}|supported-report-set`]: () =>
          ["cal:calendar-query", "cal:calendar-multiget", "d:sync-collection"].map((r) => `<d:supported-report><d:report><${r}/></d:report></d:supported-report>`).join(""),
        [`${NS.DAV}|getcontenttype`]: () => "httpd/unix-directory",
      };
    }
    case "object":
      return {
        [`${NS.DAV}|resourcetype`]: () => "",
        [`${NS.DAV}|getetag`]: () => (obj ? esc(obj.etag) : null),
        [`${NS.DAV}|getcontenttype`]: () => "text/calendar; charset=utf-8; component=vevent",
        [`${NS.DAV}|getcontentlength`]: () => (obj ? String(new TextEncoder().encode(obj.ics).length) : null),
        [`${NS.CALDAV}|calendar-data`]: () => (obj ? esc(obj.ics) : null),
        [`${NS.DAV}|current-user-privilege-set`]: common[`${NS.DAV}|current-user-privilege-set`] ?? (() => null),
      };
  }
}

type Want = { ns: string; name: string }[] | "all";
function wanted(propEl: XmlEl | undefined, isAll: boolean): Want {
  if (isAll || !propEl) return "all";
  return propEl.children.map((c) => ({ ns: c.ns, name: c.name }));
}

function responseXml(href: string, props: Record<string, () => PropVal>, want: Want, ctx: Ctx): string {
  const ok: string[] = [];
  const missing: string[] = [];
  const list = want === "all" ? Object.keys(props).filter((k) => !k.endsWith("|calendar-data")).map((k) => { const i = k.indexOf("|"); return { ns: k.slice(0, i), name: k.slice(i + 1) }; }) : want;
  for (const { ns, name } of list) {
    const q = qname(ns, name, ctx.extra);
    const v = props[`${ns}|${name}`]?.() ?? null;
    if (v === null) missing.push(`<${q}/>`);
    else ok.push(v === "" ? `<${q}/>` : `<${q}>${v}</${q}>`);
  }
  let out = `<d:response><d:href>${esc(href)}</d:href>`;
  if (ok.length) out += `<d:propstat><d:prop>${ok.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
  if (missing.length) out += `<d:propstat><d:prop>${missing.join("")}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`;
  return out + "</d:response>";
}

const multistatus = (c: Context, ctx: Ctx, body: string, tail = "") =>
  c.body(`<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${rootNsDecls(ctx.extra)}>${body}${tail}</d:multistatus>`, 207, XML);

// ---- handlers ------------------------------------------------------------------------------
dav.options("/dav/*", (c) => c.body(null, 200, { DAV: DAV_HEADER, Allow: "OPTIONS, GET, HEAD, PROPFIND, REPORT" }));

dav.on("PROPFIND", ["/", "/dav", "/dav/*"], async (c) => {
  const feed = c.get("feed");
  const node = await resolve(feed, c.req.path);
  if (!node) return c.body("not found", 404);
  const raw = await c.req.text();
  const req = raw.trim() ? parseXml(raw) : undefined;
  if (raw.trim() && (!req || req.ns !== NS.DAV || req.name !== "propfind")) return c.body("bad propfind", 400);
  const want = wanted(child(req, NS.DAV, "prop"), !req || !!child(req, NS.DAV, "allprop"));
  const depth = c.req.header("Depth") ?? "infinity";
  const ctx: Ctx = { feed, extra: new Map() };
  const parts: string[] = [];

  const tokenOf = async (pub: Publication) => formatToken(pub.id, (await pubState(pub)).token);

  if (node.kind === "calendar") {
    parts.push(responseXml(node.href, propsFor(node, ctx, await tokenOf(node.pub)), want, ctx));
    if (depth !== "0") {
      const { objs } = await allObjects(feed, node.pub);
      for (const o of objs) parts.push(responseXml(o.href, propsFor({ kind: "object", href: o.href, pub: node.pub, name: "" }, ctx, undefined, o), want, ctx));
    }
  } else if (node.kind === "object") {
    const { objs } = await allObjects(feed, node.pub);
    const o = objs.find((x) => x.href === node.href);
    if (!o) return c.body("not found", 404);
    parts.push(responseXml(o.href, propsFor(node, ctx, undefined, o), want, ctx));
  } else {
    parts.push(responseXml(node.href, propsFor(node, ctx), want, ctx));
    if (depth !== "0" && node.kind === "home") {
      for (const pub of await publications(feed.id)) {
        const n: Node = { kind: "calendar", href: P(feed).cal(pub), pub };
        parts.push(responseXml(n.href, propsFor(n, ctx, await tokenOf(pub)), want, ctx));
      }
    }
  }
  return multistatus(c, ctx, parts.join(""));
});

function timeRangeOf(req: XmlEl): [Date, Date] | undefined {
  const vcal = child(child(req, NS.CALDAV, "filter"), NS.CALDAV, "comp-filter");
  const vev = children(vcal, NS.CALDAV, "comp-filter").find((e) => e.attrs["name"]?.toUpperCase() === "VEVENT");
  const tr = child(vev, NS.CALDAV, "time-range");
  if (!tr) return undefined;
  const d = (s: string | undefined, dflt: string) => {
    const v = s ?? dflt;
    return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11) || "00"}:${v.slice(11, 13) || "00"}:${v.slice(13, 15) || "00"}Z`);
  };
  return [d(tr.attrs["start"], "19000101T000000Z"), d(tr.attrs["end"], "99990101T000000Z")];
}

dav.on("REPORT", "/dav/*", async (c) => {
  const feed = c.get("feed");
  const node = await resolve(feed, c.req.path);
  if (!node || (node.kind !== "calendar" && node.kind !== "object")) return c.body("not found", 404);
  const req = parseXml(await c.req.text());
  if (!req) return c.body("bad report", 400);
  const ctx: Ctx = { feed, extra: new Map() };
  const want = wanted(child(req, NS.DAV, "prop"), false);
  const pub = node.pub;
  const objNode = (o: Obj): Node => ({ kind: "object", href: o.href, pub, name: "" });

  if (req.ns === NS.CALDAV && req.name === "calendar-query") {
    const { objs } = await allObjects(feed, pub, timeRangeOf(req));
    return multistatus(c, ctx, objs.map((o) => responseXml(o.href, propsFor(objNode(o), ctx, undefined, o), want, ctx)).join(""));
  }

  if (req.ns === NS.CALDAV && req.name === "calendar-multiget") {
    const hrefs = children(req, NS.DAV, "href").map((h) => decodeURIComponent(new URL(h.text, "http://x").pathname));
    const { objs } = await allObjects(feed, pub);
    const byHref = new Map(objs.map((o) => [o.href, o]));
    const parts = hrefs.map((h) => {
      const o = byHref.get(h);
      return o ? responseXml(o.href, propsFor(objNode(o), ctx, undefined, o), want, ctx)
        : `<d:response><d:href>${esc(h)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
    });
    return multistatus(c, ctx, parts.join(""));
  }

  if (req.ns === NS.DAV && req.name === "sync-collection") {
    const tokenText = child(req, NS.DAV, "sync-token")?.text ?? "";
    let since = 0n;
    if (tokenText) {
      const t = parseToken(pub.id, tokenText);
      // RFC 6578 3.2: unknown/expired token -> 403 with DAV:valid-sync-token; client must full-resync.
      if (!t || t.epoch !== pub.epoch || t.seq < (await tombstoneFloor())) {
        return c.body(`<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>`, 403, XML);
      }
      since = t.seq;
    }
    const v = await view(pub, { sinceSeq: since });
    const parts: string[] = [];
    for (const [uid, r] of v.items) {
      const o = r ? objectFor(feed, pub, r) : null;
      if (o) parts.push(responseXml(o.href, propsFor(objNode(o), ctx, undefined, o), want, ctx));
      else if (since > 0n) {
        // deleted (or projected away): report the href it had
        parts.push(`<d:response><d:href>${esc(P(feed).cal(pub) + hrefName(outputUid(feed, pub, uid)))}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`);
      }
    }
    return multistatus(c, ctx, parts.join(""), `<d:sync-token>${esc(formatToken(pub.id, v.token))}</d:sync-token>`);
  }
  return c.body(`<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:supported-report/></d:error>`, 403, XML);
});

dav.on(["GET", "HEAD"], "/dav/*", async (c) => {
  const feed = c.get("feed");
  const node = await resolve(feed, c.req.path);
  if (!node || node.kind !== "object") return c.body("not found", 404);
  const { objs } = await allObjects(feed, node.pub);
  const o = objs.find((x) => x.href === node.href);
  if (!o) return c.body("not found", 404);
  if (c.req.header("If-None-Match") === o.etag) return c.body(null, 304, { ETag: o.etag });
  const h = { "Content-Type": "text/calendar; charset=utf-8", ETag: o.etag };
  return c.req.method === "HEAD" ? c.body(null, 200, h) : c.body(o.ics, 200, h);
});

// Read-only: refuse every write verb with 403 (clients treat this as "no permission").
dav.on(["PUT", "DELETE", "PROPPATCH", "MKCALENDAR", "MKCOL", "MOVE", "COPY", "POST", "LOCK", "UNLOCK"], "/dav/*", (c) =>
  c.body(`<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:need-privileges/></d:error>`, 403, XML));
