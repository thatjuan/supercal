/**
 * Authorization helpers (architecture §7). Routes use these instead of inline role checks: members
 * manage their own resources, admins everything in the tenant, owners also tenant settings, and
 * the operator tenants across the install.
 */
import { createMiddleware } from 'hono/factory';
import { Forbidden } from '../api/kit/problem.ts';
import { TENANT_ROLES, type ApiEnv, type Principal, type TenantRole } from './principal.ts';

const rank = (role: TenantRole) => TENANT_ROLES.indexOf(role);

/** True when `principal`'s tenant role is at least `min` (`member < admin < owner`). */
export const hasRole = (principal: Principal, min: TenantRole) => rank(principal.role) >= rank(min);

/** Route middleware: 403 unless the tenant role is at least `min`. */
export const requireRole = (min: TenantRole) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    if (!hasRole(c.var.principal, min)) throw new Forbidden(`Requires the ${min} role`);
    await next();
  });

/** Route middleware: 403 unless the principal is the Supercal operator. */
export const requireOperator = () =>
  createMiddleware<ApiEnv>(async (c, next) => {
    if (!c.var.principal.isOperator) throw new Forbidden('Requires the operator');
    await next();
  });

/** True when the resource belongs to the principal, or the principal is a tenant admin or owner. */
export const canManageOwned = (principal: Principal, ownerUserId: string) =>
  principal.userId === ownerUserId || hasRole(principal, 'admin');
