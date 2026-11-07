// ICS subscription endpoints: /ics/<secret>/<slug>.ics and /ics/<secret>/all.ics (combined feed).
// ETag/Last-Modified come from publication state (epoch:seq), so a 304 never renders anything.
// Rendered + compressed bodies are cached keyed by that same state.
import { Hono } from "hono";
import { brotliCompressSync, constants } from "node:zlib";
import { calendarShell, projectResource } from "./model";
import { type Feed, type Publication, feedByIcsToken, outputUid, pubState, publications, view } from "./store";

export const ics = new Hono();

const REFRESH = "PT1H";
type Bytes = Uint8Array<ArrayBuffer>;
type Body = { raw: Bytes; gzip?: Bytes; br?: Bytes };
const cache = new Map<string, Body>();
export const icsCacheStats = { hits: 0, misses: 0 };

/** Render one or more publications into a single VCALENDAR. In a combined feed the first
 *  publication (by sort order) that contains a source UID wins, so one meeting published via a
 *  passthrough and a virtual calendar appears once and the file never repeats a UID. */
export async function renderIcs(feed: Feed, pubs: Publication[], name: string): Promise<string> {
  const cal = calendarShell({ name, "x-wr-calname": name, "refresh-interval": REFRESH, "x-published-ttl": REFRESH });
  cal.getFirstProperty("refresh-interval")?.setParameter("value", "DURATION");
  const tzSeen = new Set<string>();
  const uidSeen = new Set<string>();
  for (const pub of pubs) {
    const v = await view(pub);
    for (const r of v.items.values()) {
      if (!r) continue;
      if (uidSeen.has(r.uid)) continue;
      const p = projectResource(r, { privacy: pub.privacy, keepAlarms: pub.keep_alarms, outUid: outputUid(feed, pub, r.uid) });
      if (!p) continue;
      uidSeen.add(r.uid);
      for (const tz of p.timezones) {
        const id = String(tz.getFirstPropertyValue("tzid"));
        if (!tzSeen.has(id)) { tzSeen.add(id); cal.addSubcomponent(tz); }
      }
      for (const e of p.events) cal.addSubcomponent(e);
    }
  }
  return cal.toString() + "\r\n";
}

ics.on(["GET", "HEAD"], "/ics/:token/:file", async (c) => {
  const feed = await feedByIcsToken(c.req.param("token"));
  if (!feed) return c.body("not found", 404);
  const file = c.req.param("file").replace(/\.ics$/, "");
  const all = await publications(feed.id);
  const pubs = file === "all" ? all : all.filter((p) => p.slug === file);
  if (!pubs.length) return c.body("not found", 404);

  const states = await Promise.all(pubs.map(pubState));
  const etag = `"${pubs.map((p, i) => `${p.id}.${states[i]?.token.epoch}.${states[i]?.token.seq}`).join("-")}"`;
  const lastModified = new Date(Math.max(...states.map((s) => s.lastModified.getTime())));
  const headers: Record<string, string> = {
    "Content-Type": "text/calendar; charset=utf-8",
    ETag: etag,
    "Last-Modified": lastModified.toUTCString(),
    "Cache-Control": "private, max-age=300",
    Vary: "Accept-Encoding",
    "Content-Disposition": `inline; filename="${file}.ics"`,
  };
  const inm = c.req.header("If-None-Match");
  const ims = c.req.header("If-Modified-Since");
  if (inm === etag || (!inm && ims && new Date(ims).getTime() >= Math.floor(lastModified.getTime() / 1000) * 1000)) return c.body(null, 304, headers);

  let body = cache.get(etag);
  if (body) icsCacheStats.hits++;
  else {
    icsCacheStats.misses++;
    body = { raw: new TextEncoder().encode(await renderIcs(feed, pubs, file === "all" ? "Supercal" : (pubs[0]?.name ?? file))) };
    cache.set(etag, body);
    if (cache.size > 200) cache.delete(cache.keys().next().value ?? "");
  }
  const ae = c.req.header("Accept-Encoding") ?? "";
  let out = body.raw;
  if (/\bbr\b/.test(ae)) {
    body.br ??= new Uint8Array(brotliCompressSync(body.raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }));
    out = body.br;
    headers["Content-Encoding"] = "br";
  } else if (/\bgzip\b/.test(ae)) {
    body.gzip ??= new Uint8Array(Bun.gzipSync(body.raw));
    out = body.gzip;
    headers["Content-Encoding"] = "gzip";
  }
  return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(out, 200, headers);
});
