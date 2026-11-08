/** `GET /api/v1/me`: who is calling, in which tenant and role, and every tenant they belong to. */
import { createRoute, z } from '@hono/zod-openapi';
import { member, organization, user, withControl } from '@supercal/db';
import { asc, eq } from 'drizzle-orm';
import { isTenantRole, TENANT_ROLES } from '../auth/principal.ts';
import { createApiApp, Unauthorized, problemResponses } from './kit/index.ts';
import { Tenant } from './tenants.ts';

const Membership = Tenant.extend({ role: z.enum(TENANT_ROLES) }).openapi('Membership');

const Me = z
  .object({
    user: z.object({ id: z.string(), name: z.string(), email: z.email() }),
    tenant: Tenant,
    role: z.enum(TENANT_ROLES),
    isOperator: z.boolean(),
    via: z.enum(['session', 'apiKey']),
    tenants: z.array(Membership),
  })
  .openapi('Me');

const getMe = createRoute({
  method: 'get',
  path: '/api/v1/me',
  operationId: 'getMe',
  tags: ['Account'],
  responses: {
    200: { description: 'The calling principal', content: { 'application/json': { schema: Me } } },
    ...problemResponses(401, 403),
  },
});

export const meRoutes = createApiApp().openapi(getMe, async (c) => {
  const principal = c.var.principal;
  if (principal.via === 'davLogin') throw new Unauthorized('DAV logins only grant CalDAV access');
  const { profile, memberships } = await withControl(async (tx) => ({
    profile: (await tx.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, principal.userId)))[0],
    memberships: await tx
      .select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, principal.userId))
      .orderBy(asc(organization.name)),
  }));
  const tenants = memberships.flatMap(({ role, ...tenant }) => (isTenantRole(role) ? [{ ...tenant, role }] : []));
  const current = tenants.find((tenant) => tenant.id === principal.tenantId);
  // The principal was resolved moments ago, so a missing row means it was deleted mid-request.
  if (!profile || !current) throw new Error('principal vanished while resolving /me');
  const { role: _, ...tenant } = current;
  return c.json({ user: profile, tenant, role: principal.role, isOperator: principal.isOperator, via: principal.via, tenants }, 200);
});
