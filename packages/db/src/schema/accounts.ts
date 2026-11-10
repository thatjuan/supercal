import { boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique } from 'drizzle-orm/pg-core';
import type { AccountId, SourceCalendarId } from '../ids.ts';
import { apikey, user } from './auth.ts';
import { idColumn, tenantId } from './columns.ts';

export const CONNECTED_PROVIDERS = ['google', 'microsoft', 'icloud', 'caldav', 'ics'] as const;
export const accountProvider = pgEnum('account_provider', [...CONNECTED_PROVIDERS, 'hosted']);
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

/** A calendar provider account. Credentials are encrypted; the hidden hosted account has none. */
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
  /** Last accepted `POST /accounts/{id}/sync`, for its rate limit. */
  syncRequestedAt: timestamp('sync_requested_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** What a source calendar supports; a missing `write` key in older JSON rows means false. */
export type CalendarCapabilities = { incremental: string; push: boolean; write: boolean };

/**
 * How current a source calendar's data is, as observed (never promised). `stale` is set while its
 * account cannot sync (reauth required); `expectedLatencyMs` is the current poll interval.
 */
export type Freshness = {
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  pushActive: boolean;
  expectedLatencyMs: number | null;
  stale: boolean;
};

export const NO_FRESHNESS: Freshness = { lastSuccessAt: null, lastChangeAt: null, pushActive: false, expectedLatencyMs: null, stale: false };

/** A connected or hosted calendar under its provider account. */
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
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    syncEpoch: integer('sync_epoch').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    goneAt: timestamp('gone_at', { withTimezone: true }),
    timezone: text('timezone'),
    capabilities: jsonb('capabilities').$type<CalendarCapabilities>().notNull().default({ incremental: 'snapshot', push: false, write: false }),
    state: calendarState('state').notNull().default('active'),
    freshness: jsonb('freshness').$type<Freshness>().notNull().default(NO_FRESHNESS),
  },
  (t) => [unique().on(t.accountId, t.providerCalendarId)],
);

/**
 * A provider push subscription. Google renewals overlap, so one target may have several leases.
 * `target_id` is the calendar (`calendar`) or the account (`account`, `calendar-list`).
 */
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
  /** When the subscription was made; renewal is due at 80% of `created_at` → `expires_at`. */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An OAuth authorization in progress: the PKCE verifier the signed `state` refers to, kept
 * server-side so it never travels in a URL. Single use, and only valid until `expires_at`.
 */
export const oauthFlow = pgTable('oauth_flow', {
  id: text('id').primaryKey(),
  tenantId: tenantId(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  provider: accountProvider('provider').notNull(),
  verifier: text('verifier').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Stable client-chosen object names shared by every device reading an imported calendar. */
export const davObjectName = pgTable('dav_object_name', {
  tenantId: tenantId(),
  sourceCalendarId: text('source_calendar_id').$type<SourceCalendarId>().notNull().references(() => sourceCalendar.id, { onDelete: 'cascade' }),
  uid: text('uid').notNull(),
  objectName: text('object_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.sourceCalendarId, t.uid] }), unique().on(t.sourceCalendarId, t.objectName)]);
