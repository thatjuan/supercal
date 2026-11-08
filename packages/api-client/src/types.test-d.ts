/**
 * Compile-time checks on the generated client, run by `bun run typecheck`. Each `@ts-expect-error`
 * fails the build if the mistake below it stops being a type error. Nothing here executes.
 */
import { createClient, createQueryHooks, type Problem } from './index.ts';

const client = createClient('');
const hooks = createQueryHooks(client);

export async function auditEntriesOrProblem(): Promise<string[] | Problem> {
  const { data, error } = await client.GET('/api/v1/audit-log', { params: { query: { limit: 20, targetType: 'feed' } } });
  if (error) return error;
  return data.items.map((entry) => `${entry.action} by ${entry.actor.userId} at ${entry.at}`);
}

export const auditLogOptions = () => hooks.queryOptions('get', '/api/v1/audit-log', { params: { query: { limit: 10 } } });

/** The publication union narrows on `kind`: only passthrough has `sourceCalendarId`, only virtual has `sources`. */
export async function publicationCalendars(id: string): Promise<string[] | Problem> {
  const { data, error } = await client.GET('/api/v1/publications/{id}', { params: { path: { id } } });
  if (error) return error;
  if (data.kind === 'passthrough') {
    // @ts-expect-error a passthrough publication has no sources list
    void data.sources;
    return [data.sourceCalendarId];
  }
  // @ts-expect-error a virtual publication has no single source calendar
  void data.sourceCalendarId;
  return data.sources.map((source) => source.calendarId);
}

export function rejectedCalls() {
  // @ts-expect-error nonexistent path
  hooks.queryOptions('get', '/api/v1/audit-logs');
  // @ts-expect-error limit is a number
  hooks.queryOptions('get', '/api/v1/audit-log', { params: { query: { limit: 'many' } } });
  // @ts-expect-error listAuditLog declares no request body, so any body is invalid
  void client.GET('/api/v1/audit-log', { body: { action: 'feed.create' } });
  // @ts-expect-error a virtual publication needs its sources
  void client.POST('/api/v1/feeds/{id}/publications', { params: { path: { id: 'feed_x' } }, body: { kind: 'virtual', name: 'Both' } });
  // @ts-expect-error targetType is a string
  void client.GET('/api/v1/audit-log', { params: { query: { targetType: 5 } } });
}

/** Events use the singular JSCalendar 2.0 recurrenceRule, with generated field types. */
export async function eventRecurrence(id: string, uid: string) {
  const { data, error } = await client.GET('/api/v1/calendars/{id}/events/{uid}', { params: { path: { id, uid } } });
  if (error) return error;
  if (data['@type'] === 'Event') {
    const frequency: string | undefined = data.recurrenceRule?.frequency;
    // @ts-expect-error frequency is a string enum, never a number
    const invalid: number = data.recurrenceRule?.frequency;
    return { frequency, invalid };
  }
  return data.entries;
}
