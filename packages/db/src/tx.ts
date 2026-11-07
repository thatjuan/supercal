/**
 * Transaction wrappers. Repository functions take a `TenantTx` or `ControlTx`, never a raw handle,
 * so every query runs as a restricted role: `supercal_app` bound to one tenant by RLS, or
 * `supercal_control` for the narrow cross-tenant lookups in architecture §7.
 */
import { sql } from 'drizzle-orm';
import type { TenantId } from './ids.ts';
import { unsafeDb, type Database } from './unsafe-db.ts';

export type DrizzleTx = Parameters<Parameters<Database['transaction']>[0]>[0];

declare const tenantTx: unique symbol;
declare const controlTx: unique symbol;

export type TenantTx = DrizzleTx & { readonly [tenantTx]: TenantId };
export type ControlTx = DrizzleTx & { readonly [controlTx]: true };

/** Runs `fn` in a transaction as `supercal_app`, where RLS limits every table to `tenantId`. */
export function withTenant<T>(tenantId: TenantId, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return unsafeDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'supercal_app', true), set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx as TenantTx);
  });
}

/** Runs `fn` in a transaction as `supercal_control`, before a tenant is known. */
export function withControl<T>(fn: (tx: ControlTx) => Promise<T>): Promise<T> {
  return unsafeDb().transaction(async (tx) => {
    await tx.execute(sql`set local role supercal_control`);
    return fn(tx as ControlTx);
  });
}
