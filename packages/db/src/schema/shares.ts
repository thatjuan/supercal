import { sql } from 'drizzle-orm';
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { SourceCalendarId } from '../ids.ts';
import { sourceCalendar } from './accounts.ts';
import { user } from './auth.ts';
import { idColumn, tenantId } from './columns.ts';

export const calendarAccess = pgEnum('calendar_access', ['free-busy', 'read', 'write', 'manage']);

/** A tenant member's grant; a null grantee grants every current member of the tenant. */
export const calendarShare = pgTable('calendar_share', {
  id: idColumn('shr'),
  tenantId: tenantId(),
  calendarId: text('calendar_id').$type<SourceCalendarId>().notNull().references(() => sourceCalendar.id, { onDelete: 'cascade' }),
  granteeUserId: text('grantee_user_id').references(() => user.id, { onDelete: 'cascade' }),
  access: calendarAccess('access').notNull(),
  createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('calendar_share_user_unique').on(t.calendarId, t.granteeUserId).where(sql`${t.granteeUserId} is not null`),
  uniqueIndex('calendar_share_tenant_unique').on(t.calendarId).where(sql`${t.granteeUserId} is null`),
  index('calendar_share_grantee_idx').on(t.tenantId, t.granteeUserId),
]);
