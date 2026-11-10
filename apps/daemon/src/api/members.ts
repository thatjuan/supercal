/** Owner-only membership role changes, committed with their audit entry. */
import { createRoute, z } from '@hono/zod-openapi';
import { member, withControl, withTenant } from '@supercal/db';
import { asc, eq } from 'drizzle-orm';
import { requireRole } from '../auth/policy.ts';
import { TENANT_ROLES } from '../auth/principal.ts';
import { publishAuthRevoked } from '../bus.ts';
import { pruneOrphanLinks } from '../hosted/access.ts';
import { audit, createApiApp, Forbidden, NotFound, ProblemError, problemResponses } from './kit/index.ts';

const MemberRole = z.object({ id: z.string(), userId: z.string(), role: z.enum(TENANT_ROLES) }).openapi('MemberRole');

const updateMember = createRoute({
  method: 'patch',
  path: '/api/v1/members/{id}',
  operationId: 'updateMemberRole',
  tags: ['Members'],
  middleware: [requireRole('owner')] as const,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { 'application/json': { schema: z.strictObject({ role: z.enum(TENANT_ROLES) }) } } },
  },
  responses: {
    200: { description: 'The updated membership role', content: { 'application/json': { schema: MemberRole } } },
    ...problemResponses(400, 401, 403, 404, 409),
  },
});

export const memberRoutes = createApiApp().openapi(updateMember, async (c) => {
  const principal = c.var.principal;
  const { id } = c.req.valid('param');
  const { role } = c.req.valid('json');
  const updated = await withTenant(principal.tenantId, async (tx) => {
    // Lock in a stable order, then count owners from the locked rows so concurrent demotions serialize.
    const members = await tx.select({ id: member.id, userId: member.userId, role: member.role }).from(member).orderBy(asc(member.id)).for('update');
    const current = members.find((row) => row.id === id);
    if (!current) throw new NotFound('No such member');
    if (members.find((row) => row.userId === principal.userId)?.role !== 'owner') throw new Forbidden('Requires the owner role');
    if (current.role === 'owner' && role !== 'owner' && members.filter((row) => row.role === 'owner').length === 1)
      throw new ProblemError(409, 'The tenant must have at least one owner', undefined, 'last-owner');
    await tx.update(member).set({ role }).where(eq(member.id, id));
    await audit(tx, principal, 'member.role_update', { type: 'member', id }, { from: current.role, to: role });
    if (current.role !== 'member' && role === 'member') await pruneOrphanLinks(tx);
    return { id, userId: current.userId, role };
  });
  await withControl((tx) => publishAuthRevoked(tx, updated.userId));
  return c.json(updated, 200);
});
