/**
 * The management API (architecture §12): Better Auth at `/api/auth/*`, every `/api/v1` route group,
 * the OpenAPI 3.1 document at `/api/v1/openapi.json` and Scalar at `/api/docs`. `authenticate` sets
 * `c.var.principal`: `requirePrincipal` in production, an injected one in some tests.
 */
import { apiReference } from '@scalar/hono-api-reference';
import type { MiddlewareHandler } from 'hono';
import pkg from '../../package.json' with { type: 'json' };
import type { Auth } from '../auth/auth.ts';
import { requirePrincipal, type ApiEnv } from '../auth/principal.ts';
import { apiKeyRoutes } from './api-keys.ts';
import { auditLogRoutes } from './audit-log.ts';
import { createApiApp } from './kit/index.ts';
import { meRoutes } from './me.ts';
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

/** Builds the API. Route groups are mounted after the docs, so the docs are public. */
export function createApi(auth: Auth, authenticate: MiddlewareHandler<ApiEnv> = requirePrincipal(auth)) {
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
    await next();
  });
  app.use('/api/v1/*', authenticate);
  return app.route('/', meRoutes).route('/', tenantRoutes).route('/', apiKeyRoutes).route('/', auditLogRoutes);
}
