/**
 * ICS feeds (architecture §6, §9), mounted at `/ics` when the `dav` role is enabled:
 * `GET|HEAD /ics/<token>/<pubSlug>.ics` serves one enabled publication and `/ics/<token>/all.ics`
 * every enabled publication combined.
 *
 * The ETag and Last-Modified come from one aggregate query per publication, so conditional
 * requests get a 304 before anything renders. Rendered bodies are cached as br and gzip under
 * `ETag + encoding`; a changed ETag is a miss, so nothing is ever invalidated. An unknown token or
 * slug is a 404 with an empty body, so token existence never leaks. Tokens are never logged.
 */
import { RENDER_VERSION } from '@supercal/core';
import { feed, publicationState, withControl, withTenant, type SecretBox } from '@supercal/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { brotliCompressSync, constants } from 'node:zlib';
import { icsTokenHash } from '../feeds/credentials.ts';
import { createLogger, redact } from '../log.ts';
import { createByteLru } from './cache.ts';
import { enabledPublications, renderIcs } from './render.ts';

const log = createLogger({ component: 'ics' });

const COMBINED = 'all';
const BASE_HEADERS = { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', Vary: 'Accept-Encoding' };

type Encoding = 'br' | 'gzip' | 'identity';

export type IcsDeps = {
  secrets: SecretBox;
  /** Bound on cached bodies (`SUPERCAL_ICS_CACHE_MB`). */
  cacheBytes: number;
  /** Replaceable so tests can count renders. */
  render?: typeof renderIcs;
};

/** The best encoding `Accept-Encoding` allows: br, then gzip, else identity. */
function negotiate(header: string | undefined): Encoding {
  const quality = new Map<string, number>();
  for (const entry of (header ?? '').toLowerCase().split(',')) {
    const [name = '', ...params] = entry.split(';').map((part) => part.trim());
    const q = params.find((p) => p.startsWith('q='));
    if (name) quality.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  const accepts = (name: string) => (quality.get(name) ?? quality.get('*') ?? 0) > 0;
  return accepts('br') ? 'br' : accepts('gzip') ? 'gzip' : 'identity';
}

/** Whether the client's copy is current: `If-None-Match` when sent, else `If-Modified-Since` (second precision). */
function notModified(headers: { ifNoneMatch?: string | undefined; ifModifiedSince?: string | undefined }, etag: string, lastModified: Date | null) {
  if (headers.ifNoneMatch !== undefined)
    return headers.ifNoneMatch.split(',').some((tag) => {
      const t = tag.trim();
      return t === '*' || t.replace(/^W\//, '') === etag;
    });
  const since = Date.parse(headers.ifModifiedSince ?? '');
  return lastModified !== null && !Number.isNaN(since) && Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
}

/** Builds the `/ics` routes over a fresh body cache. */
export function createIcs({ secrets, cacheBytes, render = renderIcs }: IcsDeps) {
  const cache = createByteLru(cacheBytes);
  const app = new Hono();
  app.onError((error, c) => {
    log.error('ics request failed', { path: redact(c.req.path), error });
    return c.body(null, 500);
  });

  // Hono answers HEAD with this GET handler and drops the body.
  app.get('/:token/:file', async (c) => {
    const file = c.req.param('file');
    if (!file.endsWith('.ics')) return c.body(null, 404);
    const slug = file.slice(0, -'.ics'.length);
    const combined = slug === COMBINED;

    const [owner] = await withControl((tx) =>
      tx.select({ id: feed.id, tenantId: feed.tenantId }).from(feed).where(eq(feed.icsTokenHash, icsTokenHash(c.req.param('token')))),
    );
    if (!owner) return c.body(null, 404);

    return withTenant(owner.tenantId, async (tx) => {
      const [target] = await tx.select().from(feed).where(eq(feed.id, owner.id));
      if (!target) return c.body(null, 404);
      const enabled = await enabledPublications(tx, target.id);
      const publications = combined ? enabled : enabled.filter((p) => p.slug === slug);
      if (publications.length === 0 && !combined) return c.body(null, 404);

      const states = await Promise.all(publications.map((p) => publicationState(tx, p.sources.map((s) => s.sourceCalendarId))));
      const segments = publications.map((p, i) => [p.id, p.epoch, states[i]?.maxSeq ?? 0n, p.configVersion, RENDER_VERSION].join('.'));
      const etag = `"${segments.join('~') || `empty.${RENDER_VERSION}`}"`;
      // Edits to names and order change no `changed_at`, so the rows' own update times count too.
      const times = [...states.map((s) => s.lastChangedAt), ...publications.map((p) => p.updatedAt), ...(combined ? [target.updatedAt] : [])];
      const lastModified = times.reduce<Date | null>((latest, t) => (t && (!latest || t > latest) ? t : latest), null);
      const headers: Record<string, string> = { ...BASE_HEADERS, ETag: etag, ...(lastModified && { 'Last-Modified': lastModified.toUTCString() }) };

      if (notModified({ ifNoneMatch: c.req.header('If-None-Match'), ifModifiedSince: c.req.header('If-Modified-Since') }, etag, lastModified))
        return c.body(null, 304, headers);

      const encoding = negotiate(c.req.header('Accept-Encoding'));
      if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
      const cached = cache.get(`${etag}:${encoding === 'br' ? 'br' : 'gzip'}`);
      if (cached) return c.body(encoding === 'identity' ? Bun.gunzipSync(cached) : cached, 200, headers);

      const body = new TextEncoder().encode(await render(tx, secrets, { feed: target, publications, combined }));
      const variants = {
        br: new Uint8Array(brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
        gzip: Bun.gzipSync(body),
      };
      cache.set(`${etag}:br`, variants.br);
      cache.set(`${etag}:gzip`, variants.gzip);
      return c.body(encoding === 'identity' ? body : variants[encoding], 200, headers);
    });
  });
  app.all('*', (c) => c.body(null, 404));
  return app;
}
