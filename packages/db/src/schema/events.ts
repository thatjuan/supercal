import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgSequence, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { SOURCE_FORMATS, type EventResource } from '@supercal/core';
import type { SourceCalendarId } from '../ids.ts';
import { sourceCalendar } from './accounts.ts';
import { tenantId, tstzrange } from './columns.ts';

export const sourceFormat = pgEnum('source_format', SOURCE_FORMATS);
export type SourceFormat = (typeof sourceFormat.enumValues)[number];

export const completeness = pgEnum('completeness', ['complete', 'incomplete']);
export type Completeness = (typeof completeness.enumValues)[number];

/** Allocates `resource.seq` (bigint); only `recordChanges` calls `nextval` on it. */
export const changeSeq = pgSequence('change_seq');

const sourceCalendarId = () =>
  text('source_calendar_id')
    .$type<SourceCalendarId>()
    .notNull()
    .references(() => sourceCalendar.id, { onDelete: 'cascade' });

/**
 * Raw layer: provider responses, or authoritative hosted iCalendar, kept for re-normalisation.
 * `original_start` is the recurrence identity as the provider wrote it (date or date-time).
 */
export const sourceObject = pgTable(
  'source_object',
  {
    tenantId: tenantId(),
    sourceCalendarId: sourceCalendarId(),
    providerObjectId: text('provider_object_id').notNull(),
    format: sourceFormat('format').notNull(),
    payload: text('payload').notNull(),
    etag: text('etag'),
    groupUid: text('group_uid').notNull(),
    originalStart: text('original_start'),
    seenGeneration: bigint('seen_generation', { mode: 'number' }).notNull().default(0),
    dirty: boolean('dirty').notNull().default(true),
    normalizerVersion: integer('normalizer_version').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.sourceCalendarId, t.providerObjectId] }),
    index('source_object_group_idx').on(t.sourceCalendarId, t.groupUid),
    index('source_object_dirty_idx').on(t.sourceCalendarId).where(sql`${t.dirty}`),
  ],
);

/**
 * Derived layer and change log: one iCalendar object per UID per source calendar, with the `seq`
 * of its last change. Deletions are tombstones (`deleted`, `data` null). Written only by `recordChanges`.
 */
export const resource = pgTable(
  'resource',
  {
    tenantId: tenantId(),
    sourceCalendarId: sourceCalendarId(),
    uid: text('uid').notNull(),
    objectName: text('object_name'),
    data: jsonb('data').$type<EventResource>(),
    revision: text('revision').notNull(),
    sequence: integer('sequence').notNull().default(0),
    lastModified: timestamp('last_modified', { withTimezone: true }),
    organizer: text('organizer'),
    span: tstzrange('span'),
    completeness: completeness('completeness').notNull().default('complete'),
    completenessReason: text('completeness_reason'),
    deleted: boolean('deleted').notNull().default(false),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceCalendarId, t.uid] }),
    index('resource_seq_idx').on(t.sourceCalendarId, t.seq),
    index('resource_span_idx').using('gist', t.span),
  ],
);

/** Resolves Graph `cancelledOccurrences` ids to their original start. */
export const graphOccurrence = pgTable(
  'graph_occurrence',
  {
    tenantId: tenantId(),
    sourceCalendarId: sourceCalendarId(),
    masterId: text('master_id').notNull(),
    occurrenceId: text('occurrence_id').notNull(),
    originalStart: text('original_start').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceCalendarId, t.masterId, t.occurrenceId] })],
);
