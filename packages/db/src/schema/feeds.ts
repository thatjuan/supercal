import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AccountId, FeedId, PublicationId, SinkId, SourceCalendarId } from '../ids.ts';
import { accountProvider, calendarAccount, connectionStatus, sourceCalendar } from './accounts.ts';
import { user } from './auth.ts';
import { idColumn, tenantId } from './columns.ts';

export const publicationKind = pgEnum('publication_kind', ['passthrough', 'virtual']);
export type PublicationKind = (typeof publicationKind.enumValues)[number];

export const privacy = pgEnum('privacy', ['full', 'title-only', 'busy-only']);
export type Privacy = (typeof privacy.enumValues)[number];

/** `disabled-invalid`: the system disabled the publication because it no longer makes sense (see `status_detail`). */
export const publicationStatus = pgEnum('publication_status', ['ok', 'disabled-invalid']);
export type PublicationStatus = (typeof publicationStatus.enumValues)[number];

export type PublicationFilters = { hideDeclined: boolean; hideCancelled: boolean; hideAllDay: boolean };

/**
 * One user's set of published calendars. `caldav_username` is the global CalDAV login;
 * `uid_secret` is a secret-box ciphertext of the HMAC key for privacy UIDs. Each user has at most
 * one default feed per tenant.
 */
export const feed = pgTable(
  'feed',
  {
    id: idColumn('feed'),
    tenantId: tenantId(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    caldavUsername: text('caldav_username').notNull().unique(),
    caldavPasswordHash: text('caldav_password_hash'),
    icsTokenHash: text('ics_token_hash').unique(),
    uidSecret: text('uid_secret').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('feed_default_unique').on(t.tenantId, t.ownerUserId).where(sql`is_default`)],
);

/** A bearer URL publishing one calendar, with an independent token and privacy UID key. */
export const calendarLink = pgTable('calendar_link', {
  id: idColumn('lnk'),
  tenantId: tenantId(),
  calendarId: text('calendar_id')
    .$type<SourceCalendarId>()
    .notNull()
    .references(() => sourceCalendar.id, { onDelete: 'cascade' }),
  name: text('name'),
  tokenHash: text('token_hash').notNull().unique(),
  privacy: privacy('privacy').notNull(),
  uidSecret: text('uid_secret').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A calendar in a feed: one source (passthrough) or a merge of several (virtual). */
export const publication = pgTable(
  'publication',
  {
    id: idColumn('pub'),
    tenantId: tenantId(),
    feedId: text('feed_id')
      .$type<FeedId>()
      .notNull()
      .references(() => feed.id, { onDelete: 'cascade' }),
    kind: publicationKind('kind').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    color: text('color'),
    privacy: privacy('privacy').notNull().default('full'),
    filters: jsonb('filters')
      .$type<PublicationFilters>()
      .notNull()
      .default({ hideDeclined: false, hideCancelled: false, hideAllDay: false }),
    keepAlarms: boolean('keep_alarms').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    epoch: integer('epoch').notNull().default(0),
    configVersion: integer('config_version').notNull().default(0),
    status: publicationStatus('status').notNull().default('ok'),
    statusDetail: text('status_detail'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.feedId, t.slug)],
);

export const publicationSource = pgTable(
  'publication_source',
  {
    tenantId: tenantId(),
    publicationId: text('publication_id')
      .$type<PublicationId>()
      .notNull()
      .references(() => publication.id, { onDelete: 'cascade' }),
    sourceCalendarId: text('source_calendar_id')
      .$type<SourceCalendarId>()
      .notNull()
      .references(() => sourceCalendar.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.sourceCalendarId] })],
);

/** `calendar_missing`: the user deleted the sink's calendar at the provider, so the sink stopped. */
export const sinkStatus = pgEnum('sink_status', ['active', 'calendar_missing']);
export type SinkStatus = (typeof sinkStatus.enumValues)[number];

/**
 * Mirrors a publication into a calendar Supercal created on one of the owner's provider accounts.
 * `provider_subject` + `provider_calendar_id` identify that calendar across every account linked
 * to the same identity, so discovery never ingests it (loop prevention). One sink per publication
 * and account.
 */
export const sink = pgTable(
  'sink',
  {
    id: idColumn('snk'),
    tenantId: tenantId(),
    publicationId: text('publication_id')
      .$type<PublicationId>()
      .notNull()
      .references(() => publication.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .$type<AccountId>()
      .notNull()
      .references(() => calendarAccount.id, { onDelete: 'cascade' }),
    provider: accountProvider('provider').notNull(),
    providerSubject: text('provider_subject'),
    providerCalendarId: text('provider_calendar_id').notNull(),
    status: sinkStatus('status').notNull().default('active'),
    /** The IANA zone the provider calendar was created in; floating times are read in it. */
    timeZone: text('time_zone'),
    /** When the runner last wrote (or deleted) a provider event. */
    lastWriteAt: timestamp('last_write_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.publicationId, t.accountId)],
);

/**
 * The write ledger: one row per mirrored object (output UID). `provider_event_id` is the master's
 * (or only) provider event, `event_ids` every provider event written for the UID (master and
 * overrides), and `applied_revision` what was last written, so only real changes are rewritten.
 */
export const sinkEvent = pgTable(
  'sink_event',
  {
    tenantId: tenantId(),
    sinkId: text('sink_id')
      .$type<SinkId>()
      .notNull()
      .references(() => sink.id, { onDelete: 'cascade' }),
    uid: text('uid').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventIds: text('event_ids').array().notNull().default(sql`'{}'::text[]`),
    appliedRevision: text('applied_revision').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sinkId, t.uid] })],
);
