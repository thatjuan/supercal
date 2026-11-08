import { Hono } from 'hono';
import { createApi, type ApiDeps } from './api/index.ts';
import { createDav } from './dav/index.ts';
import { createIcs } from './ics/index.ts';
import type { Role } from './roles.ts';

/** What the HTTP app runs on: the API's dependencies, the public URL for CalDAV sync tokens, and the ICS body cache bound in bytes. */
export type AppDeps = ApiDeps & { publicUrl?: string | undefined; icsCacheBytes: number };

/** Builds the HTTP app: `/healthz` always, plus the route groups of each enabled role. */
export function createApp(roles: ReadonlySet<Role>, deps: AppDeps) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (roles.has('api')) app.route('/', createApi(deps));
  if (roles.has('dav')) app.route('/', createDav(deps)).route('/ics', createIcs({ secrets: deps.secrets, cacheBytes: deps.icsCacheBytes }));
  return app;
}
