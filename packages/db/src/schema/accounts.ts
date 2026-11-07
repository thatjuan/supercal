import { boolean, jsonb, pgEnum, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { AccountId } from '../ids.ts';
import { apikey, user } from './auth.ts';
import { idColumn, tenantId } from './columns.ts';

export const accountProvider = pgEnum('account_provider', ['google', 'microsoft', 'icloud', 'caldav', 'ics']);
export type AccountProvider = (typeof accountProvider.enumValues)[number];

/** Connection health of a calendar account, and of a sink writing to one. */
export const connectionStatus = pgEnum('connection_status', ['active', 'reauth_required', 'error', 'disabled']);
export type ConnectionStatus = (typeof connectionStatus.enumValues)[number];

export const calendarState = pgEnum('calendar_state', ['active', 'gone']);
export type CalendarState = (typeof calendarState.enumValues)[number];

export const pushTarget = pgEnum('push_target', ['account', 'calendar', 'calendar-list']);
export type PushTarget = (typeof pushTarget.enumValues)[number];

/** Immutable API key → tenant binding, written only by our API; key metadata is user-editable and never trusted. */
export const apiKeyTenant = pgTable('api_key_tenant', {
  apiKeyId: text('api_key_id')
    .primaryKey()
    .references(() => apikey.id, { onDelete: 'cascade' }),
  tenantId: tenantId(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

/** A connected provider account. `credentials` is a secret-box ciphertext (see `secrets.ts`). */
export const calendarAccount = pgTable('calendar_account', {
  id: idColumn('acc'),
  tenantId: tenantId(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  provider: accountProvider('provider').notNull(),
  displayName: text('display_name').notNull(),
  providerSubject: text('provider_subject'),
  email: text('email'),
  serverUrl: text('server_url'),
  credentials: text('credentials'),
  status: connectionStatus('status').notNull().default('active'),
  statusDetail: text('status_detail'),
  autoPublish: boolean('auto_publish').notNull().default(true),
});

/** A calendar discovered on an account. */
export const sourceCalendar = pgTable(
  'source_calendar',
  {
    id: idColumn('cal'),
    tenantId: tenantId(),
    accountId: text('account_id')
      .$type<AccountId>()
      .notNull()
      .references(() => calendarAccount.id, { onDelete: 'cascade' }),
    providerCalendarId: text('provider_calendar_id').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    timezone: text('timezone'),
    capabilities: jsonb('capabilities').notNull().default({}),
    state: calendarState('state').notNull().default('active'),
    freshness: jsonb('freshness').notNull().default({}),
  },
  (t) => [unique().on(t.accountId, t.providerCalendarId)],
);

/** A provider push subscription. Google renewals overlap, so one target may have several leases. */
export const pushLease = pgTable('push_lease', {
  providerChannelId: text('provider_channel_id').primaryKey(),
  tenantId: tenantId(),
  accountId: text('account_id')
    .$type<AccountId>()
    .notNull()
    .references(() => calendarAccount.id, { onDelete: 'cascade' }),
  target: pushTarget('target').notNull(),
  targetId: text('target_id').notNull(),
  providerResourceId: text('provider_resource_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  secretHash: text('secret_hash').notNull(),
  providerState: jsonb('provider_state'),
});
