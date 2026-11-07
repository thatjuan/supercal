/** The full Postgres schema (architecture §4) and the row types other packages use. */
import type { apiKeyTenant, calendarAccount, pushLease, sourceCalendar } from './accounts.ts';
import type { graphOccurrence, resource, sourceObject } from './events.ts';
import type { feed, publication, publicationSource, sink, sinkEvent } from './feeds.ts';
import type { auditLog, syncTarget, systemSetting } from './system.ts';

export * from './auth.ts';
export * from './accounts.ts';
export * from './events.ts';
export * from './feeds.ts';
export * from './system.ts';
export type { Span } from './columns.ts';

export type ApiKeyTenant = typeof apiKeyTenant.$inferSelect;
export type CalendarAccount = typeof calendarAccount.$inferSelect;
export type SourceCalendar = typeof sourceCalendar.$inferSelect;
export type PushLease = typeof pushLease.$inferSelect;
export type SourceObject = typeof sourceObject.$inferSelect;
export type Resource = typeof resource.$inferSelect;
export type GraphOccurrence = typeof graphOccurrence.$inferSelect;
export type Feed = typeof feed.$inferSelect;
export type Publication = typeof publication.$inferSelect;
export type PublicationSource = typeof publicationSource.$inferSelect;
export type Sink = typeof sink.$inferSelect;
export type SinkEvent = typeof sinkEvent.$inferSelect;
export type SyncTarget = typeof syncTarget.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type SystemSetting = typeof systemSetting.$inferSelect;
