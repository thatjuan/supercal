import { Hono } from 'hono';
import { createApi, type ApiDeps } from './api/index.ts';
import { createDav } from './dav/index.ts';
import { ics } from './ics/index.ts';
import type { Role } from './roles.ts';

/** Builds the HTTP app: `/healthz` always, plus the route groups of each enabled role. `publicUrl` goes into CalDAV sync tokens. */
export function createApp(roles: ReadonlySet<Role>, deps: ApiDeps & { publicUrl?: string | undefined }) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (roles.has('api')) app.route('/', createApi(deps));
  if (roles.has('dav')) app.route('/', createDav(deps)).route('/ics', ics);
  return app;
}
