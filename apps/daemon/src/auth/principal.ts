/**
 * The principal behind a management request (architecture §7). `requirePrincipal` resolves it for
 * every `/api/v1/*` route and sets `c.var.principal`; routes authorize with `policy.ts`.
 */
import { apiKeyTenant, member, parseTenantId, user, withControl, type TenantId } from '@supercal/db';
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { Forbidden, Unauthorized } from '../api/kit/problem.ts';
import type { FeedService } from '../feeds/service.ts';
import type { SyncDeps } from '../sync/index.ts';
import { OPERATOR_ROLE, type Auth } from './auth.ts';

export const TENANT_ROLES = ['member', 'admin', 'owner'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** A user acting in exactly one tenant. A `service` kind (organization-owned keys) may join this union later. */
export type Principal = {
  kind: 'user';
  userId: string;
  tenantId: TenantId;
  role: TenantRole;
  via: 'session' | 'apiKey';
  isOperator: boolean;
};

export type ApiEnv = { Variables: { principal: Principal; auth: Auth; feeds: FeedService; sync: SyncDeps } };

export const isTenantRole = (role: string): role is TenantRole => TENANT_ROLES.some((known) => known === role);

/** The user's current role in `tenantId` and whether they are the operator; null if not a member (or banned). */
async function membership(userId: string, tenantId: TenantId) {
  const [row] = await withControl((tx) =>
    tx
      .select({ role: member.role, userRole: user.role, banned: user.banned })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.userId, userId), eq(member.organizationId, tenantId)))
      .limit(1),
  );
  if (!row || row.banned || !isTenantRole(row.role)) return null;
  return { role: row.role, isOperator: row.userRole === OPERATOR_ROLE };
}

/**
 * A bearer API key: verified by Better Auth, then tenant-bound through `api_key_tenant`, never key
 * metadata (users can edit it). Throws 401 for an invalid or unbound key.
 */
async function fromApiKey(auth: Auth, key: string): Promise<Principal> {
  const verified = await auth.api.verifyApiKey({ body: { key } });
  if (!verified.valid || !verified.key) throw new Unauthorized('Invalid API key');
  const keyId = verified.key.id;
  const [binding] = await withControl((tx) => tx.select().from(apiKeyTenant).where(eq(apiKeyTenant.apiKeyId, keyId)).limit(1));
  if (!binding || binding.userId !== verified.key.referenceId) throw new Unauthorized('Invalid API key');
  const current = await membership(binding.userId, binding.tenantId);
  if (!current) throw new Unauthorized('The key’s user is no longer a member of its tenant');
  return { kind: 'user', userId: binding.userId, tenantId: binding.tenantId, via: 'apiKey', ...current };
}

/** A session cookie: its active organization, rechecked against current membership. */
async function fromSession(auth: Auth, headers: Headers): Promise<Principal> {
  const found = await auth.api.getSession({ headers });
  if (!found) throw new Unauthorized();
  const tenantId = parseTenantId(found.session.activeOrganizationId ?? '');
  if (!tenantId) throw new Forbidden('Select a tenant first (organization/set-active)', 'no-active-tenant');
  const current = await membership(found.user.id, tenantId);
  if (!current) throw new Forbidden('You are not a member of the active tenant', 'no-active-tenant');
  return { kind: 'user', userId: found.user.id, tenantId, via: 'session', ...current };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Resolves the principal behind request `headers`, throwing a 401/403 problem. `Authorization:
 * Bearer <key>` wins and never falls back to the cookie, so a bad key is a 401 even beside a valid
 * session. Long-lived streams call it again to revalidate.
 */
export async function resolvePrincipal(auth: Auth, headers: Headers): Promise<Principal> {
  const authorization = headers.get('authorization');
  if (authorization === null) return fromSession(auth, headers);
  const key = BEARER.exec(authorization)?.[1];
  if (!key) throw new Unauthorized('Expected Authorization: Bearer <api key>');
  return fromApiKey(auth, key);
}

/** Middleware for `/api/v1/*`: sets `c.var.principal` from `resolvePrincipal`. */
export const requirePrincipal = (auth: Auth) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    c.set('principal', await resolvePrincipal(auth, c.req.raw.headers));
    await next();
  });
