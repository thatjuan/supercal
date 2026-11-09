/** Shared expansion and UTC formatting for direct calendars and projected feed previews. */
import { z } from '@hono/zod-openapi';
import { Temporal } from '@js-temporal/polyfill';
import { expandOccurrences, getProp, propParam, status, summary, textValue, type EventResource } from '@supercal/core';
import { BadRequest } from './kit/index.ts';

export const Occurrence = z.object({ uid: z.string(), recurrenceId: z.string(), start: z.string(), end: z.string(), timeZone: z.string().nullable(), allDay: z.boolean(), title: z.string(), status: z.string(), location: z.string().optional() });
export const MAX_CALENDAR_OCCURRENCES = 5_000;
export function occurrenceWindow(range: { from: string; to: string }): { from: Date; to: Date } {
  const from = new Date(range.from), to = new Date(range.to);
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 366 * 86400_000) throw new BadRequest([{ path: 'to', message: 'Window must be positive and at most 366 days' }]);
  return { from, to };
}
export function expandResourceOccurrences(resource: EventResource, range: { from: Date; to: Date }, zone = 'UTC', limit = MAX_CALENDAR_OCCURRENCES) {
  const expansion = expandOccurrences(resource, { from: Temporal.Instant.fromEpochMilliseconds(range.from.getTime()), to: Temporal.Instant.fromEpochMilliseconds(range.to.getTime()) }, zone, limit);
  return { items: expansion.occurrences.map((o) => {
    const start = getProp(o.component, 'dtstart'), location = textValue(o.component, 'location');
    return { uid: resource.uid, recurrenceId: o.recurrenceId, start: o.start.toString(), end: o.end.toString(), timeZone: start ? propParam(start, 'tzid') ?? (textValue(o.component, 'dtstart')?.endsWith('Z') ? 'Etc/UTC' : null) : null,
      allDay: o.allDay, title: summary(o.component) ?? '', status: status(o.component)?.toLowerCase() ?? 'confirmed', ...(location !== null && { location }) };
  }), truncated: expansion.truncated };
}
export function expandCalendarResources(rows: { data: EventResource }[], range: { from: Date; to: Date }, zone: string) {
  const items: z.infer<typeof Occurrence>[] = [];
  let truncated = false;
  const skipped: string[] = [];
  for (const row of rows) {
    let expansion: ReturnType<typeof expandResourceOccurrences>;
    try {
      expansion = expandResourceOccurrences(row.data, range, zone, MAX_CALENDAR_OCCURRENCES - items.length + 1);
    } catch {
      skipped.push(row.data.uid);
      continue;
    }
    items.push(...expansion.items); truncated ||= expansion.truncated;
    if (items.length > MAX_CALENDAR_OCCURRENCES) { truncated = true; break; }
  }
  items.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid) || a.recurrenceId.localeCompare(b.recurrenceId));
  return { items: items.slice(0, MAX_CALENDAR_OCCURRENCES), truncated, skipped };
}
