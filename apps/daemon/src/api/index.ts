/**
 * The management API (architecture §12): Better Auth at `/api/auth/*`, every `/api/v1` route group,
 * the OpenAPI 3.1 document at `/api/v1/openapi.json` and Scalar at `/api/docs`. `authenticate` sets
 * `c.var.principal`: `requirePrincipal` in production, an injected one in some tests. `bus` feeds
 * the live stream; `idleBus` builds the API where nothing streams (OpenAPI generation, tests).
 */
import { apiReference } from '@scalar/hono-api-reference';
import { withControl, type SecretBox } from '@supercal/db';
import { sql } from 'drizzle-orm';
import { createGuardedFetch, type AdapterRegistry, type GoogleClientOptions, type GuardedFetch } from '@supercal/providers';
import type { Context, MiddlewareHandler } from 'hono';
import { clientIp, CLIENT_IP_HEADER } from '../client-ip.ts';
import { bodyLimit } from 'hono/body-limit';
import pkg from '../../package.json' with { type: 'json' };
import type { Auth } from '../auth/auth.ts';
import { requirePrincipal, type ApiEnv } from '../auth/principal.ts';
import { createFeedService } from '../feeds/service.ts';
import type { Bus } from '../bus.ts';
import { createLogger } from '../log.ts';
import { createStateSigner, type OAuthClient, type OAuthDeps } from '../oauth/common.ts';
import { googleOAuthRoutes } from '../oauth/google.ts';
import { microsoftOAuthRoutes } from '../oauth/microsoft.ts';
import { createSyncDeps } from '../sync/index.ts';
import { accountRoutes } from './accounts.ts';
import { apiKeyRoutes } from './api-keys.ts';
import { auditLogRoutes } from './audit-log.ts';
import { calendarRoutes } from './calendars.ts';
import { davLoginRoutes } from './dav-logins.ts';
import { freeBusyRoutes } from './free-busy.ts';
import { shareRoutes } from './shares.ts';
import { eventRoutes } from './events.ts';
import { feedRoutes } from './feeds.ts';
import { instanceRoutes, type Signup } from './instance.ts';
import { createApiApp, Forbidden } from './kit/index.ts';
import { linkRoutes } from './links.ts';
import { meRoutes } from './me.ts';
import { memberRoutes } from './members.ts';
import { publicationRoutes } from './publications.ts';
import { sinkRoutes } from './sinks.ts';
import { subscribeRoutes } from './subscribe.ts';
import { streamRoutes, type StreamOptions } from './stream.ts';
import { tenantRoutes } from './tenants.ts';

const BOOTSTRAP_LOCK = 44001;

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

// Published 2026-10-23. This release reads localStorage on startup, so a CSP sandbox prevents rendering.
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0';

/**
 * What the API runs on: Better Auth, the secret box for values stored encrypted, the bus that
 * feeds the live stream (`idleBus` where nothing streams, such as OpenAPI generation and tests),
 * for connecting accounts the outbound transport, provider adapters (default: no LAN
 * exceptions, and the registered adapters) and OAuth settings (default: no OAuth providers), the
 * Google API client sinks call (default: the Google OAuth client against the real API), and the
 * sign-up mode `GET /api/v1/instance` reports (default: `invite`).
 */
export type ApiDeps = {
  auth: Auth;
  clientIpHeader?: string | undefined;
  secrets: SecretBox;
  bus: Bus;
  stream?: StreamOptions;
  fetch?: GuardedFetch;
  adapters?: AdapterRegistry;
  oauth?: OAuthConfig;
  googleApi?: GoogleClientOptions | undefined;
  signup?: Signup;
};

/** OAuth settings: `WEB_ORIGIN`, the state signing secret, and each configured provider's client. Redirect URIs are built on the auth's public URL. */
export type OAuthConfig = { webOrigin?: string | undefined; stateSecret: string; google?: OAuthClient | undefined; microsoft?: OAuthClient | undefined };

/** Builds the API. The docs and `/api/v1/instance` are mounted before authentication, so they are public. */
export function createApi(
  { auth, secrets, bus, stream, fetch, adapters, oauth: oauthConfig, googleApi, signup = 'invite', clientIpHeader }: ApiDeps,
  authenticate: MiddlewareHandler<ApiEnv> = requirePrincipal(auth),
) {
  const feeds = createFeedService(secrets);
  const sync = createSyncDeps({
    secrets,
    feeds,
    fetch: fetch ?? createGuardedFetch({ allow: [] }),
    log: createLogger({ component: 'api' }),
    ...(adapters && { adapters }),
    google: googleApi ?? (oauthConfig?.google && { clientId: oauthConfig.google.clientId, clientSecret: oauthConfig.google.clientSecret, tokenUrl: oauthConfig.google.tokenUrl }),
  });
  const oauth: OAuthDeps = {
    publicUrl: auth.publicUrl,
    returnOrigins: [new URL(auth.publicUrl).origin, ...(oauthConfig?.webOrigin ? [new URL(oauthConfig.webOrigin).origin] : [])],
    state: createStateSigner(oauthConfig?.stateSecret ?? crypto.randomUUID()),
    google: oauthConfig?.google ?? null,
    microsoft: oauthConfig?.microsoft ?? null,
  };
  const app = createApiApp();
  app.get('/api/auth/reference', apiReference(async () => ({
    cdn: SCALAR_CDN,
    content: await auth.api.generateOpenAPISchema(),
    pageTitle: 'Supercal authentication API',
  })));
  app.use('/api/auth/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ message: 'Request body too large' }, 413) }));
  function toAuth(c: Context, raw = c.req.raw) {
    const request = new Request(raw);
    const ip = clientIp(c, clientIpHeader);
    if (ip) request.headers.set(CLIENT_IP_HEADER, ip);
    else request.headers.delete(CLIENT_IP_HEADER);
    return auth.handler(request);
  }
  app.post('/api/auth/sign-up/email', async (c) => {
    if (!(await auth.isEmptyInstall())) return toAuth(c);
    const request = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body: await c.req.raw.arrayBuffer() });
    // A narrow exception to tx.ts: hold the main-pool lock across Better Auth's separate-pool
    // queries only during bootstrap. Waiters never occupy the pool the winner needs to insert.
    return withControl(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);
      return toAuth(c, request);
    });
  });
  app.on(['GET', 'POST'], '/api/auth/*', (c) => toAuth(c));
  app.openAPIRegistry.registerComponent('securitySchemes', 'session', { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' });
  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key sent as `Authorization: Bearer <key>`',
  });
  app.doc31('/api/v1/openapi.json', openApiConfig);
  app.get('/api/docs', apiReference({ cdn: SCALAR_CDN, url: '/api/v1/openapi.json', pageTitle: 'Supercal API' }));
  const providers = { google: oauth.google !== null, microsoft: oauth.microsoft !== null };
  app.route('/', instanceRoutes({ signup, providers }, auth.isEmptyInstall));
  app.use('/api/v1/*', async (c, next) => {
    c.set('auth', auth);
    c.set('feeds', feeds);
    c.set('sync', sync);
    c.set('oauth', oauth);
    await next();
  });
  app.use('/api/v1/*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.header('Authorization')) return next();
    const origin = c.req.header('Origin');
    const site = c.req.header('Sec-Fetch-Site');
    const allowed = origin ? oauth.returnOrigins.includes(origin) : site === undefined || site === 'same-origin' || site === 'none';
    if (!allowed) throw new Forbidden('Cross-origin requests are not allowed', 'cross-origin');
    await next();
  });
  app.use('/api/v1/*', authenticate);
  return app
    .route('/', meRoutes)
    .route('/', tenantRoutes)
    .route('/', memberRoutes)
    .route('/', apiKeyRoutes)
    .route('/', accountRoutes)
    .route('/', googleOAuthRoutes)
    .route('/', microsoftOAuthRoutes)
    .route('/', calendarRoutes)
    .route('/', linkRoutes(secrets))
    .route('/', eventRoutes)
    .route('/', shareRoutes)
    .route('/', freeBusyRoutes)
    .route('/', auditLogRoutes)
    .route('/', feedRoutes)
    .route('/', davLoginRoutes)
    .route('/', publicationRoutes)
    .route('/', subscribeRoutes)
    .route('/', sinkRoutes)
    .route('/', streamRoutes(bus, stream));
}
