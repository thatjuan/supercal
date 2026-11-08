import { Hono } from 'hono';
import { createApi, type ApiDeps } from './api/index.ts';
import { createDav } from './dav/index.ts';
import { googleHooks } from './hooks/google.ts';
import { microsoftHooks } from './hooks/microsoft.ts';
import { createIcs } from './ics/index.ts';
import { metrics } from './ops/metrics.ts';
import { opsRoutes, type OpsDeps } from './ops/index.ts';
import type { Role } from './roles.ts';
import { webRoutes } from './web.ts';

/**
 * What the HTTP app runs on: the API's dependencies, the public URL for CalDAV sync tokens, the
 * ICS body cache bound in bytes, the built dashboard's directory, and the ops endpoints' settings.
 */
export type AppDeps = ApiDeps & { publicUrl?: string | undefined; icsCacheBytes: number; webDir?: string; ops?: Omit<OpsDeps, 'bus'> };

/** The `kind` label of `supercal_feed_requests_total` for a request path, or null when it is no feed request. */
const feedKind = (path: string) => (path.startsWith('/ics/') ? 'ics' : /^\/(?:dav(?:\/|$)|\.well-known\/caldav$)/.test(path) ? 'caldav' : null);

/**
 * Builds the HTTP app: `/healthz`, `/readyz` and `/metrics` always, plus the route groups of each
 * enabled role (push webhooks come with `api`). With the `api` role and a built dashboard in
 * `webDir`, the dashboard is mounted last, behind every other route.
 */
export function createApp(roles: ReadonlySet<Role>, deps: AppDeps) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.route('/', opsRoutes({ bus: deps.bus, ...deps.ops }));
  if (roles.has('api')) app.route('/', createApi(deps)).route('/', googleHooks).route('/', microsoftHooks);
  if (roles.has('dav')) {
    app.use('*', async (c, next) => {
      await next();
      const kind = feedKind(c.req.path);
      if (kind) metrics.feedRequests.inc({ kind, status: String(c.res.status) });
    });
    app.route('/', createDav(deps)).route('/ics', createIcs({ secrets: deps.secrets, cacheBytes: deps.icsCacheBytes }));
  }
  const web = roles.has('api') && deps.webDir !== undefined ? webRoutes(deps.webDir) : null;
  if (web) app.route('/', web);
  return app;
}
