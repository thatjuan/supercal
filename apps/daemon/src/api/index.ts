/**
 * The management API (architecture §12): Better Auth at `/api/auth/*`, every `/api/v1` route group,
 * the OpenAPI 3.1 document at `/api/v1/openapi.json` and Scalar at `/api/docs`. `authenticate` sets
 * `c.var.principal`: `requirePrincipal` in production, an injected one in some tests. `bus` feeds
 * the live stream; `idleBus` builds the API where nothing streams (OpenAPI generation, tests).
 */
import { apiReference } from '@scalar/hono-api-reference';
import type { SecretBox } from '@supercal/db';
import { createGuardedFetch, type AdapterRegistry, type GuardedFetch } from '@supercal/providers';
import type { MiddlewareHandler } from 'hono';
import pkg from '../../package.json' with { type: 'json' };
import type { Auth } from '../auth/auth.ts';
import { requirePrincipal, type ApiEnv } from '../auth/principal.ts';
import { createFeedService } from '../feeds/service.ts';
import type { Bus } from '../bus.ts';
import { createLogger } from '../log.ts';
import { createSyncDeps } from '../sync/index.ts';
import { accountRoutes } from './accounts.ts';
import { apiKeyRoutes } from './api-keys.ts';
import { auditLogRoutes } from './audit-log.ts';
import { calendarRoutes } from './calendars.ts';
import { feedRoutes } from './feeds.ts';
import { createApiApp } from './kit/index.ts';
import { meRoutes } from './me.ts';
import { publicationRoutes } from './publications.ts';
import { subscribeRoutes } from './subscribe.ts';
import { streamRoutes, type StreamOptions } from './stream.ts';
import { tenantRoutes } from './tenants.ts';

/** Settings for `getOpenAPI31Document` / `doc31`, shared by the served document and `bun run api:spec`. */
export const openApiConfig = {
  openapi: '3.1.0',
  info: {
    title: 'Supercal API',
    version: pkg.version,
    description: 'Sign-up, sign-in, sessions and organizations are documented separately in the [authentication reference](/api/auth/reference).',
  },
  security: [{ session: [] }, { apiKey: [] }],
};

/**
 * What the API runs on: Better Auth, the secret box for values stored encrypted, the bus that
 * feeds the live stream (`idleBus` where nothing streams, such as OpenAPI generation and tests),
 * and for connecting accounts the outbound transport and provider adapters (default: no LAN
 * exceptions, and the registered adapters).
 */
export type ApiDeps = { auth: Auth; secrets: SecretBox; bus: Bus; stream?: StreamOptions; fetch?: GuardedFetch; adapters?: AdapterRegistry };

/** Builds the API. Route groups are mounted after the docs, so the docs are public. */
export function createApi({ auth, secrets, bus, stream, fetch, adapters }: ApiDeps, authenticate: MiddlewareHandler<ApiEnv> = requirePrincipal(auth)) {
  const feeds = createFeedService(secrets);
  const sync = createSyncDeps({
    secrets,
    feeds,
    fetch: fetch ?? createGuardedFetch({ allow: [] }),
    log: createLogger({ component: 'api' }),
    ...(adapters && { adapters }),
  });
  const app = createApiApp();
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  app.openAPIRegistry.registerComponent('securitySchemes', 'session', { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key sent as `Authorization: Bearer <key>`',
  });
  app.doc31('/api/v1/openapi.json', openApiConfig);
  app.get('/api/docs', apiReference({ url: '/api/v1/openapi.json', pageTitle: 'Supercal API' }));
  app.use('/api/v1/*', async (c, next) => {
    c.set('auth', auth);
    c.set('feeds', feeds);
    c.set('sync', sync);
    await next();
  });
  app.use('/api/v1/*', authenticate);
  return app
    .route('/', meRoutes)
    .route('/', tenantRoutes)
    .route('/', apiKeyRoutes)
    .route('/', accountRoutes)
    .route('/', calendarRoutes)
    .route('/', auditLogRoutes)
    .route('/', feedRoutes)
    .route('/', publicationRoutes)
    .route('/', subscribeRoutes)
    .route('/', streamRoutes(bus, stream));
}
