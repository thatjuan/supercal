import { Hono } from 'hono';
import { createApi } from './api/index.ts';
import { dav } from './dav/index.ts';
import { ics } from './ics/index.ts';
import type { Role } from './roles.ts';

/** Builds the HTTP app: `/healthz` always, plus the route groups of each enabled role. */
export function createApp(roles: ReadonlySet<Role>) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (roles.has('api')) app.route('/', createApi());
  if (roles.has('dav')) app.route('/', dav).route('/ics', ics);
  return app;
}
