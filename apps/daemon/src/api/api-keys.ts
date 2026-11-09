/**
 * API keys (architecture §7). Keys belong to a user and are bound to the tenant they were issued
 * in through `api_key_tenant`; the binding, not Better Auth's key metadata, decides the tenant.
 * Members see and delete their own keys, admins every key in the tenant.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { apikey, apiKeyTenant, withControl, withTenant } from '@supercal/db';
import { and, desc, eq } from 'drizzle-orm';
import { canManageOwned, hasRole } from '../auth/policy.ts';
import { audit, createApiApp, Forbidden, NotFound, ProblemError, problemResponses } from './kit/index.ts';
import { publishAuthRevoked } from '../bus.ts';
import { createLogger } from '../log.ts';

const log = createLogger({ component: 'api-keys' });

const ApiKey = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    start: z.string().nullable().openapi({ description: 'The first characters of the key, to recognise it' }),
    userId: z.string(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .openapi('ApiKey');

const ApiKeyList = z.object({ items: z.array(ApiKey) }).openapi('ApiKeyList');

const CreatedApiKey = z
  .object({ id: z.string(), name: z.string(), key: z.string().openapi({ description: 'The secret; shown only in this response' }) })
  .openapi('CreatedApiKey');

const listApiKeys = createRoute({
  method: 'get',
  path: '/api/v1/api-keys',
  operationId: 'listApiKeys',
  tags: ['API keys'],
  responses: {
    200: { description: 'Your keys in this tenant (every key, for admins), newest first', content: { 'application/json': { schema: ApiKeyList } } },
    ...problemResponses(401, 403),
  },
});

const createApiKey = createRoute({
  method: 'post',
  path: '/api/v1/api-keys',
  operationId: 'createApiKey',
  tags: ['API keys'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ name: z.string().min(1).max(32), expiresInDays: z.int().min(1).max(365).optional() }),
        },
      },
    },
  },
  responses: {
    201: { description: 'The new key, with its secret', content: { 'application/json': { schema: CreatedApiKey } } },
    ...problemResponses(400, 401, 403),
  },
});

const deleteApiKey = createRoute({
  method: 'delete',
  path: '/api/v1/api-keys/{id}',
  operationId: 'deleteApiKey',
  tags: ['API keys'],
  request: { params: z.object({ id: z.string() }) },
  responses: { 204: { description: 'Deleted' }, ...problemResponses(401, 403, 404) },
});

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Deletes a Better Auth key row directly: its own delete endpoint needs a session we may not have. */
const destroyKey = (id: string) => withControl((tx) => tx.delete(apikey).where(eq(apikey.id, id)));

export const apiKeyRoutes = createApiApp()
  .openapi(listApiKeys, async (c) => {
    const principal = c.var.principal;
    const rows = await withControl((tx) =>
      tx
        .select({
          id: apikey.id,
          name: apikey.name,
          start: apikey.start,
          userId: apiKeyTenant.userId,
          createdAt: apikey.createdAt,
          expiresAt: apikey.expiresAt,
          lastUsedAt: apikey.lastRequest,
        })
        .from(apiKeyTenant)
        .innerJoin(apikey, eq(apikey.id, apiKeyTenant.apiKeyId))
        .where(and(eq(apiKeyTenant.tenantId, principal.tenantId), hasRole(principal, 'admin') ? undefined : eq(apiKeyTenant.userId, principal.userId)))
        .orderBy(desc(apikey.createdAt), desc(apikey.id)),
    );
    const items = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: iso(row.expiresAt), lastUsedAt: iso(row.lastUsedAt) }));
    return c.json({ items }, 200);
  })
  .openapi(createApiKey, async (c) => {
    const { name, expiresInDays } = c.req.valid('json');
    const principal = c.var.principal;
    if (principal.via !== 'session') throw new Forbidden('API keys can only be issued from a signed-in session');
    // 1. Create the key. Better Auth writes through its own adapter, outside any transaction of ours.
    const created = await c.var.auth.api.createApiKey({
      body: { name, userId: principal.userId, expiresIn: expiresInDays === undefined ? null : expiresInDays * 86_400 },
    });
    // 2. Commit the tenant binding. Without it the key is unusable, so on failure delete it.
    try {
      await withTenant(principal.tenantId, async (tx) => {
        await tx.insert(apiKeyTenant).values({ apiKeyId: created.id, tenantId: principal.tenantId, userId: principal.userId });
        await audit(tx, principal, 'api_key.create', { type: 'api_key', id: created.id }, { name, expiresInDays });
      });
    } catch (error) {
      log.error('API key binding failed; deleting the key', { error });
      await destroyKey(created.id);
      throw new ProblemError(500, 'The key could not be issued');
    }
    // 3. Only now hand out the secret.
    return c.json({ id: created.id, name, key: created.key }, 201);
  })
  .openapi(deleteApiKey, async (c) => {
    const { id } = c.req.valid('param');
    const principal = c.var.principal;
    await withTenant(principal.tenantId, async (tx) => {
      const [binding] = await tx.select().from(apiKeyTenant).where(eq(apiKeyTenant.apiKeyId, id));
      if (!binding) throw new NotFound('No such API key');
      if (!canManageOwned(principal, binding.userId)) throw new Forbidden('You can only delete your own keys');
      await tx.delete(apiKeyTenant).where(eq(apiKeyTenant.apiKeyId, id));
      await audit(tx, principal, 'api_key.delete', { type: 'api_key', id });
      await publishAuthRevoked(tx, binding.userId);
    });
    // The unbound key is already unusable; this removes the secret itself.
    await destroyKey(id);
    return c.body(null, 204);
  });
