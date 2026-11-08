import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { TenantId } from '../ids.ts';
import { organization } from './auth.ts';
import { idColumn, tenantId } from './columns.ts';

export const syncKind = pgEnum('sync_kind', ['discover', 'events', 'push_renew', 'sink', 'maintenance']);
export type SyncKind = (typeof syncKind.enumValues)[number];

/**
 * The scheduler: one leased job per `(kind, target_id)`. `target_id` is the id of the account
 * (`discover`, and the `push_renew` of its calendar-list watch), calendar (`events`, `push_renew`) or sink, or a fixed job name (`maintenance`).
 * Maintenance jobs span tenants, so their `tenant_id` is null and only `supercal_control` sees them.
 */
export const syncTarget = pgTable(
  'sync_target',
  {
    id: idColumn('tgt'),
    tenantId: text('tenant_id')
      .$type<TenantId>()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: syncKind('kind').notNull(),
    targetId: text('target_id').notNull(),
    cursor: jsonb('cursor'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseVersion: bigint('lease_version', { mode: 'number' }).notNull().default(0),
    wakeGeneration: bigint('wake_generation', { mode: 'number' }).notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    retryAfter: timestamp('retry_after', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.kind, t.targetId), index('sync_target_next_run_idx').on(t.nextRunAt)],
);

/** Who did what in a tenant. `actor` is the acting principal. */
export const auditLog = pgTable('audit_log', {
  id: idColumn('aud'),
  tenantId: tenantId(),
  actor: jsonb('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  data: jsonb('data'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

/** Install-wide settings, not tenant-scoped. Seeded with `tombstone_floor = 0`. */
export const systemSetting = pgTable('system_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});
