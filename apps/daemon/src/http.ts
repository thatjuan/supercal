import { Hono } from 'hono';
import { createApi, type ApiDeps } from './api/index.ts';
import { createDav } from './dav/index.ts';
import { googleHooks } from './hooks/google.ts';
import { microsoftHooks } from './hooks/microsoft.ts';
import { createIcs } from './ics/index.ts';
import type { Role } from './roles.ts';
import { webRoutes } from './web.ts';

/**
 * What the HTTP app runs on: the API's dependencies, the public URL for CalDAV sync tokens, the
 * ICS body cache bound in bytes, and the built dashboard's directory.
 */
export type AppDeps = ApiDeps & { publicUrl?: string | undefined; icsCacheBytes: number; webDir?: string };

/**
 * Builds the HTTP app: `/healthz` always, plus the route groups of each enabled role (push webhooks
 * come with `api`). With the `api` role and a built dashboard in `webDir`, the dashboard is mounted
 * last, behind every other route.
 */
export function createApp(roles: ReadonlySet<Role>, deps: AppDeps) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (roles.has('api')) app.route('/', createApi(deps)).route('/', googleHooks).route('/', microsoftHooks);
  if (roles.has('dav')) app.route('/', createDav(deps)).route('/ics', createIcs({ secrets: deps.secrets, cacheBytes: deps.icsCacheBytes }));
  const web = roles.has('api') && deps.webDir !== undefined ? webRoutes(deps.webDir) : null;
  if (web) app.route('/', web);
  return app;
}
