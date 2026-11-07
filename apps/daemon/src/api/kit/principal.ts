/**
 * Stub principal and authorization helpers. #4 replaces this module with the real resolver
 * (`auth/principal.ts`) and policy (`auth/policy.ts`); route code depends only on these names.
 */
import type { TenantId } from '@supercal/db';
import { createMiddleware } from 'hono/factory';
import { Forbidden, Unauthorized } from './problem.ts';

export type TenantRole = 'owner' | 'admin' | 'member';

export type Principal = {
  kind: 'user';
  userId: string;
  tenantId: TenantId;
  role: TenantRole;
  via: 'session' | 'apiKey';
  isOperator: boolean;
};

export type ApiEnv = { Variables: { principal: Principal } };

const RANK: Record<TenantRole, number> = { member: 0, admin: 1, owner: 2 };

/** Placeholder for #4's resolver: rejects every request, so `/api/v1/*` fails closed until auth lands. */
export const requirePrincipal = createMiddleware<ApiEnv>(async () => {
  throw new Unauthorized('Authentication is not configured');
});

/** Route middleware: 403 unless the principal's tenant role is at least `min`. */
export const requireRole = (min: TenantRole) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    if (RANK[c.var.principal.role] < RANK[min]) throw new Forbidden(`Requires the ${min} role`);
    await next();
  });
