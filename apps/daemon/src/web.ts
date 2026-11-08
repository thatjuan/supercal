/**
 * Serves the built dashboard (`apps/web/dist`, copied to `SUPERCAL_WEB_DIR`) from the `api` role.
 * Files under `assets/` carry content hashes and are cached for a year; everything else, including
 * the `index.html` that unknown paths fall back to for client-side routing, is revalidated on
 * every load. Paths owned by the daemon (API, DAV, ICS, discovery, hooks) never fall back.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Hono } from 'hono';

const DAEMON_PATHS = /^\/(?:api|dav|ics|hooks|\.well-known|healthz|readyz|metrics)(?:\/|$)/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Where the dashboard lives by default: `web/` next to the running binary. */
export const defaultWebDir = () => join(dirname(process.execPath), 'web');

/** A file response for `path`, or null when it is missing or not a regular file. */
async function fileResponse(path: string, cacheControl: string, method: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const headers = { 'content-type': file.type, 'cache-control': cacheControl, 'content-length': String(file.size) };
  return new Response(method === 'HEAD' ? null : file, { headers });
}

/** GET/HEAD routes for the dashboard in `dir`; null when `dir` has no `index.html` (nothing built). */
export function webRoutes(dir: string) {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) return null;

  return new Hono().on(['GET', 'HEAD'], '*', async (c, next) => {
    const path = c.req.path;
    if (DAEMON_PATHS.test(path)) return next();
    const target = resolve(root, `.${path}`);
    if (target.startsWith(root + sep) && target !== index) {
      const cache = target.startsWith(join(root, 'assets') + sep) ? IMMUTABLE : 'no-cache';
      const found = await fileResponse(target, cache, c.req.method);
      if (found) return found;
      // A missing hashed asset is a stale build reference, not a client route.
      if (cache === IMMUTABLE) return c.notFound();
    }
    return (await fileResponse(index, 'no-cache', c.req.method)) ?? c.notFound();
  });
}
