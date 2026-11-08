import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth.ts';
import { idColumn, tenantId } from './columns.ts';

/** One revocable CalDAV credential per device, independent of feed and API credentials. */
export const davLogin = pgTable('dav_login', {
  id: idColumn('dvl'),
  tenantId: tenantId(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('dav_login_username', sql`${t.username} ~ '^[a-z0-9-]+$'`)]);
