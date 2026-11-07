/**
 * The API kit end to end: a test-only `widgets` route group (mounted only here) for validation,
 * problems and If-Match, and the real audit-log endpoint for pagination over Postgres.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import { createRoute, z } from '@hono/zod-openapi';
import { closeDb, connectDb, migrate, organization, withTenant, type TenantId } from '@supercal/db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { createApi } from '../src/api/index.ts';
import { idleBus } from '../src/bus.ts';
import {
  audit,
  createApiApp,
  etagOf,
  ifMatchHeaders,
  NotFound,
  problemResponses,
  redactSecrets,
  requireIfMatch,
} from '../src/api/kit/index.ts';
import type { ApiEnv, Principal } from '../src/auth/principal.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const tenantId = `org_${crypto.randomUUID()}` as TenantId;
let principal: Principal = { kind: 'user', userId: 'user_test', tenantId, role: 'admin', via: 'session', isOperator: false };
const injectPrincipal = createMiddleware<ApiEnv>(async (c, next) => {
  c.set('principal', principal);
  await next();
});

const Widget = z.object({ id: z.string(), name: z.string().min(1) });
const widget = { id: 'w1', name: 'First', updatedAt: new Date('2026-01-01T00:00:00Z') };
const params = z.object({ id: z.string() });
const widgetResponse = { description: 'Widget', content: { 'application/json': { schema: Widget } } };

const widgets = createApiApp()
  .openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets',
      request: { body: { required: true, content: { 'application/json': { schema: Widget.omit({ id: true }) } } } },
      responses: { 201: widgetResponse, ...problemResponses(400) },
    }),
    (c) => c.json({ id: 'w2', ...c.req.valid('json') }, 201),
  )
  .openapi(
    createRoute({ method: 'get', path: '/api/v1/widgets/{id}', request: { params }, responses: { 200: widgetResponse, ...problemResponses(404) } }),
    (c) => {
      if (c.req.valid('param').id !== widget.id) throw new NotFound('No such widget');
      return c.json({ id: widget.id, name: widget.name }, 200, { ETag: etagOf(widget) });
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/widgets/{id}',
      request: { params, headers: ifMatchHeaders, body: { content: { 'application/json': { schema: Widget.omit({ id: true }) } } } },
      responses: { 200: widgetResponse, ...problemResponses(404, 412, 428) },
    }),
    (c) => {
      requireIfMatch(c, etagOf(widget), { required: true });
      return c.json({ id: widget.id, ...c.req.valid('json') }, 200);
    },
  )
  .get('/api/v1/widgets-boom', () => {
    throw new Error('connection string postgres://secret@db');
  });

const fixture = testAuth('invite');
const app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }, injectPrincipal).route('/', widgets);

const send = (path: string, init?: RequestInit) => app.request(path, init);
const json = (method: string, body: string, headers: Record<string, string> = {}): RequestInit => ({
  method,
  body,
  headers: { 'Content-Type': 'application/json', ...headers },
});

describe('problems', () => {
  test('an invalid body is a 400 problem listing each field', async () => {
    const res = await send('/api/v1/widgets', json('POST', '{"name":""}'));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toStartWith('application/problem+json');
    expect(await res.json()).toMatchObject({
      type: 'https://supercal.dev/problems/bad-request',
      status: 400,
      instance: '/api/v1/widgets',
      errors: [{ path: 'name' }],
    });
  });

  test('malformed JSON is a 400 problem', async () => {
    const res = await send('/api/v1/widgets', json('POST', '{'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'https://supercal.dev/problems/bad-request' });
  });

  test('NotFound renders as a 404 problem', async () => {
    const res = await send('/api/v1/widgets/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      type: 'https://supercal.dev/problems/not-found',
      title: 'Not found',
      status: 404,
      detail: 'No such widget',
      instance: '/api/v1/widgets/nope',
    });
  });

  test('an unexpected error is a 500 that leaks nothing', async () => {
    const res = await send('/api/v1/widgets-boom');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret');
  });
});

describe('If-Match', () => {
  const etag = etagOf(widget);
  const patch = (headers: Record<string, string>) => send('/api/v1/widgets/w1', json('PATCH', '{"name":"Renamed"}', headers));

  test('GET returns the ETag, and PATCH with it succeeds', async () => {
    expect((await send('/api/v1/widgets/w1')).headers.get('etag')).toBe(etag);
    expect((await patch({ 'If-Match': etag })).status).toBe(200);
  });

  test('a stale If-Match is a 412', async () => {
    const res = await patch({ 'If-Match': 'W/"w1.0"' });
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ type: 'https://supercal.dev/problems/precondition-failed' });
  });

  test('a missing If-Match on a route that requires it is a 428', async () => {
    expect((await patch({})).status).toBe(428);
  });
});

describe('redactSecrets', () => {
  test('drops secret-named keys at any depth', () => {
    const data = { name: 'Work', Password: 'x', nested: [{ token: 't', url: 'https://a' }], credentials: { user: 'u' } };
    expect(redactSecrets(data)).toEqual({ name: 'Work', nested: [{ url: 'https://a' }] });
  });
});

describe('OpenAPI document', () => {
  test('is served, and is a valid OpenAPI 3.1 document', async () => {
    const res = await send('/api/v1/openapi.json');
    expect(await res.json()).toMatchObject({ openapi: '3.1.0', info: { title: 'Supercal API' } });
    // Validate the committed document (production routes only; `check:api-client` keeps it current).
    await SwaggerParser.validate(new URL('../../../packages/api-client/openapi.json', import.meta.url).pathname);
  });

  test('Scalar renders at /api/docs', async () => {
    const res = await send('/api/docs');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/api/v1/openapi.json');
  });
});

describe.skipIf(!testDatabaseUrl)('audit log pagination', () => {
  beforeAll(async () => {
    const url = testDatabaseUrl ?? '';
    await migrate(url);
    connectDb(url);
    await unsafeDb().insert(organization).values({ id: tenantId, name: 'Kit', slug: tenantId, createdAt: new Date() });
    // Three transactions of 40: entries share now() within each, so the id tie-break is exercised.
    for (let batch = 0; batch < 3; batch++) {
      await withTenant(tenantId, async (tx) => {
        for (let i = 0; i < 40; i++) {
          await audit(tx, principal, 'feed.update', { type: 'feed', id: `feed_${batch}` }, { n: batch * 40 + i, token: 'hidden' });
        }
      });
    }
  });

  afterAll(async () => {
    await unsafeDb().delete(organization).where(eq(organization.id, tenantId));
    await closeDb();
  });

  type Page = { items: { id: string; data: { n: number } }[]; nextCursor: string | null };
  const list = async (query: string) => {
    const res = await send(`/api/v1/audit-log?${query}`);
    return { status: res.status, body: (await res.json()) as Page };
  };

  test('120 entries come back in three pages, newest first, with no duplicates or gaps', async () => {
    const pages: Page[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const { status, body } = await list(`limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      expect(status).toBe(200);
      pages.push(body);
      cursor = body.nextCursor;
    }
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 20]);
    const ns = pages.flatMap((p) => p.items.map((item) => item.data.n));
    expect(new Set(ns).size).toBe(120);
    expect(pages.flatMap((p) => p.items).every((item) => !('token' in item.data))).toBe(true);
    // Within a batch the order is by id, so check batches (not individual entries) are newest first.
    expect(ns.slice(0, 40).every((n) => n >= 80)).toBe(true);
    expect(ns.slice(80).every((n) => n < 40)).toBe(true);
  });

  test('filters by target', async () => {
    const { body } = await list('targetType=feed&targetId=feed_1&limit=100');
    expect(body.items.map((item) => item.data.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => 40 + i));
    expect(body.nextCursor).toBeNull();
  });

  test('a tampered or unknown-version cursor is a 400', async () => {
    const { body } = await list('limit=1');
    const tampered = `${body.nextCursor?.slice(0, -2)}xx`;
    const v2 = Buffer.from(JSON.stringify({ v: 2, createdAt: '2026-01-01T00:00:00.000000Z', id: 'aud_x' })).toString('base64url');
    for (const cursor of [tampered, v2, 'not-a-cursor']) expect((await list(`cursor=${cursor}`)).status).toBe(400);
  });

  test('members may not read it', async () => {
    principal = { ...principal, role: 'member' };
    try {
      expect((await list('limit=1')).status).toBe(403);
    } finally {
      principal = { ...principal, role: 'admin' };
    }
  });
});
