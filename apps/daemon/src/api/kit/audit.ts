/** The audit log: every mutation calls `audit` inside the transaction that made the change. */
import { z } from '@hono/zod-openapi';
import { auditLog, type TenantTx } from '@supercal/db';
import type { Principal } from '../../auth/principal.ts';

/** Every audited action. Feature issues add theirs here. */
export type AuditAction =
  | 'dav-login.create'
  | 'dav-login.delete'
  | 'event.create'
  | 'event.update'
  | 'event.delete'
  | 'tenant.create'
  | 'tenant.update'
  | 'api_key.create'
  | 'api_key.delete'
  | 'calendar.create'
  | 'calendar.update'
  | 'calendar.delete'
  | 'calendar.restore'
  | 'link.create'
  | 'link.update'
  | 'link.delete'
  | 'account.create'
  | 'account.update'
  | 'account.delete'
  | 'account.sync'
  | 'account.reconnect'
  | 'account.credentials.update'
  | 'feed.create'
  | 'feed.update'
  | 'feed.delete'
  | 'feed.credentials.rotate'
  | 'publication.create'
  | 'publication.update'
  | 'publication.delete'
  | 'publication.reorder'
  | 'sink.create'
  | 'sink.delete';

/** The actor recorded on each entry: who acted and how they authenticated. */
export const AuditActor = z.object({ kind: z.literal('user'), userId: z.string(), via: z.enum(['session', 'apiKey', 'davLogin']) }).openapi('AuditActor');

export type AuditTarget = { type: string; id?: string };

const SECRET_KEYS = new Set(['password', 'token', 'secret', 'credentials']);

/** Deep copy of `value` without any key named password, token, secret or credentials (any case). */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase()))
      .map(([key, entry]) => [key, redactSecrets(entry)]),
  );
}

/** Records `action` on `target` by `principal`; `data` is stored after `redactSecrets`. */
export async function audit(
  tx: TenantTx,
  principal: Principal,
  action: AuditAction,
  target: AuditTarget,
  data?: Record<string, unknown>,
): Promise<void> {
  const actor: z.infer<typeof AuditActor> = { kind: principal.kind, userId: principal.userId, via: principal.via };
  await tx.insert(auditLog).values({
    tenantId: principal.tenantId,
    actor,
    action,
    targetType: target.type,
    targetId: target.id ?? null,
    data: data === undefined ? null : redactSecrets(data),
  });
}
