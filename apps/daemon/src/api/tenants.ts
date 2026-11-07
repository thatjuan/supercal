/**
 * Tenants (Better Auth organizations). `GET|PATCH /api/v1/tenant` is the caller's current tenant
 * (PATCH needs owner); `GET|POST /api/v1/tenants` is the operator's install-wide view. Membership
 * and invitations stay on Better Auth's own `/api/auth/organization/*` endpoints.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { organization, user, withControl, withTenant } from '@supercal/db';
import { asc, eq } from 'drizzle-orm';
import { insertTenant, slugFor } from '../auth/auth.ts';
import { requireOperator, requireRole } from '../auth/policy.ts';
import { audit, BadRequest, Conflict, createApiApp, problemResponses } from './kit/index.ts';

const Slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens');

export const Tenant = z.object({ id: z.string(), name: z.string(), slug: z.string() }).openapi('Tenant');

const tenantColumns = { id: organization.id, name: organization.name, slug: organization.slug };
const tenantResponse = (description: string) => ({ description, content: { 'application/json': { schema: Tenant } } });

/** True when `error` (or the driver error Drizzle wraps in `cause`) is a Postgres unique violation. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && (Reflect.get(error, 'code') === '23505' || isUniqueViolation(error.cause));

const slugTaken = (error: unknown) => {
  if (isUniqueViolation(error)) throw new Conflict('That slug is taken');
  throw error;
};

const getTenant = createRoute({
  method: 'get',
  path: '/api/v1/tenant',
  operationId: 'getTenant',
  tags: ['Tenants'],
  responses: { 200: tenantResponse('The current tenant'), ...problemResponses(401, 403) },
});

const updateTenant = createRoute({
  method: 'patch',
  path: '/api/v1/tenant',
  operationId: 'updateTenant',
  tags: ['Tenants'],
  middleware: [requireRole('owner')] as const,
  request: {
    body: { required: true, content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(100), slug: Slug }).partial() } } },
  },
  responses: { 200: tenantResponse('The updated tenant'), ...problemResponses(400, 401, 403, 409) },
});

const TenantList = z.object({ items: z.array(Tenant) }).openapi('TenantList');

const listTenants = createRoute({
  method: 'get',
  path: '/api/v1/tenants',
  operationId: 'listTenants',
  tags: ['Tenants'],
  middleware: [requireOperator()] as const,
  responses: {
    200: { description: 'Every tenant in the install, by name', content: { 'application/json': { schema: TenantList } } },
    ...problemResponses(401, 403),
  },
});

const CreatedTenant = z
  .object({
    tenant: Tenant,
    owner: z.object({ id: z.string(), email: z.email() }).nullable(),
    passwordResetUrl: z.url().nullable().openapi({ description: 'One-time link for an owner account created by this request; shown once' }),
  })
  .openapi('CreatedTenant');

const createTenant = createRoute({
  method: 'post',
  path: '/api/v1/tenants',
  operationId: 'createTenant',
  tags: ['Tenants'],
  middleware: [requireOperator()] as const,
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(100),
            slug: Slug.optional(),
            ownerEmail: z.email().optional().openapi({ description: 'Initial owner; created with a password-reset link if no such user exists' }),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'The new tenant', content: { 'application/json': { schema: CreatedTenant } } },
    ...problemResponses(400, 401, 403, 409),
  },
});

export const tenantRoutes = createApiApp()
  .openapi(getTenant, async (c) => {
    const [tenant] = await withTenant(c.var.principal.tenantId, (tx) => tx.select(tenantColumns).from(organization));
    if (!tenant) throw new Error('current tenant not visible to its own transaction');
    return c.json(tenant, 200);
  })
  .openapi(updateTenant, async (c) => {
    const changes = c.req.valid('json');
    if (changes.name === undefined && changes.slug === undefined) throw new BadRequest([], 'Nothing to update');
    const principal = c.var.principal;
    const tenant = await withTenant(principal.tenantId, async (tx) => {
      const [row] = await tx.update(organization).set(changes).where(eq(organization.id, principal.tenantId)).returning(tenantColumns);
      await audit(tx, principal, 'tenant.update', { type: 'tenant', id: principal.tenantId }, changes);
      return row;
    }).catch(slugTaken);
    if (!tenant) throw new Error('current tenant not visible to its own transaction');
    return c.json(tenant, 200);
  })
  .openapi(listTenants, async (c) => {
    const items = await withControl((tx) => tx.select(tenantColumns).from(organization).orderBy(asc(organization.name), asc(organization.id)));
    return c.json({ items }, 200);
  })
  .openapi(createTenant, async (c) => {
    const { name, slug = slugFor(name), ownerEmail } = c.req.valid('json');
    const taken = await withControl((tx) => tx.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)));
    if (taken.length > 0) throw new Conflict('That slug is taken');

    let owner: { id: string; email: string } | null = null;
    let passwordResetUrl: string | null = null;
    if (ownerEmail !== undefined) {
      const email = ownerEmail.toLowerCase();
      [owner = null] = await withControl((tx) => tx.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, email)));
      if (!owner) {
        // Better Auth's user creation cannot join our transaction; an owner left without a tenant can still sign in.
        const created = await c.var.auth.api.createUser({ body: { email, name: email.split('@')[0] ?? email, password: crypto.randomUUID() } });
        owner = { id: created.user.id, email: created.user.email };
        passwordResetUrl = await c.var.auth.passwordResetLink(email);
      }
    }

    const tenant = await withControl((tx) => insertTenant(tx, { name, slug, ownerId: owner?.id })).catch(slugTaken);
    const id = tenant.id;
    // Recorded in the new tenant's log, so its admins can see who created it.
    await withTenant(id, (tx) => audit(tx, { ...c.var.principal, tenantId: id }, 'tenant.create', { type: 'tenant', id }, { name, slug, ownerEmail }));
    return c.json({ tenant, owner, passwordResetUrl }, 201);
  });
