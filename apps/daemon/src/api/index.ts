/**
 * The management API (architecture §12): every `/api/v1` route group, the OpenAPI 3.1 document at
 * `/api/v1/openapi.json` and Scalar at `/api/docs`. `authenticate` sets `c.var.principal`; tests
 * inject one, production uses #4's resolver.
 */
import { apiReference } from '@scalar/hono-api-reference';
import type { MiddlewareHandler } from 'hono';
import pkg from '../../package.json' with { type: 'json' };
import { auditLogRoutes } from './audit-log.ts';
import { createApiApp, requirePrincipal, type ApiEnv } from './kit/index.ts';

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
export function createApi(authenticate: MiddlewareHandler<ApiEnv> = requirePrincipal) {
  const app = createApiApp();
  app.openAPIRegistry.registerComponent('securitySchemes', 'session', { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key sent as `Authorization: Bearer <key>`',
  });
  app.doc31('/api/v1/openapi.json', openApiConfig);
  app.get('/api/docs', apiReference({ url: '/api/v1/openapi.json', pageTitle: 'Supercal API' }));
  app.use('/api/v1/*', authenticate);
  return app.route('/', auditLogRoutes);
}
