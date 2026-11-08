import { Temporal } from '@js-temporal/polyfill';
import { removeProps } from '../accessors.ts';
import type { EventResource } from '../model.ts';
import { expandOccurrences } from '../time.ts';
import { fromJSCalendar, toJSCalendar } from './convert.ts';

export class InvalidSplitError extends Error {}

/** Split a recurrence in wall time. COUNT counts rule instances before EXDATE subtraction (RFC 5545). */
export function splitEvent(resource: EventResource, at: string, newUid: string, now: Temporal.Instant): { original: EventResource; next: EventResource } {
  const event = toJSCalendar(resource);
  if (event['@type'] !== 'Event' || !resource.master || !event.recurrenceRule) throw new InvalidSplitError('Only an event with a recurring master can be split');
  if (newUid === resource.uid) throw new InvalidSplitError('The new UID must differ from the original');
  const split = Temporal.PlainDateTime.from(at);
  const first = Temporal.PlainDateTime.from(event.start);
  if (Temporal.PlainDateTime.compare(split, first) <= 0) throw new InvalidSplitError('Split must be after the first occurrence; use PATCH to edit the whole series');
  const zone = event.timeZone ?? 'UTC';
  const window = { from: first.toZonedDateTime(zone).toInstant().subtract({ seconds: 1 }), to: split.toZonedDateTime(zone).toInstant().add({ hours: 25 }) };
  const bare: EventResource = { ...resource, master: removeProps(resource.master, ['exdate', 'rdate']), overrides: [] };
  const expansion = expandOccurrences(bare, window, zone, 200_000);
  if (expansion.truncated) throw new InvalidSplitError('Series is too large to split safely');
  const ids = expansion.occurrences.map((o) => o.recurrenceId.replace(/Z$/, '').length === 10 ? `${o.recurrenceId}T00:00:00` : o.recurrenceId.replace(/Z$/, ''));
  const index = ids.indexOf(at);
  if (index < 0 || event.recurrenceOverrides?.[at]?.excluded === true) throw new InvalidSplitError('Split point is not an occurrence');
  const before = index;
  if (before === 0) throw new InvalidSplitError('Split must be after the first occurrence');
  const earlier = Object.fromEntries(Object.entries(event.recurrenceOverrides ?? {}).filter(([date]) => date < at));
  const later = Object.fromEntries(Object.entries(event.recurrenceOverrides ?? {}).filter(([date]) => date >= at));
  const originalRule = { ...event.recurrenceRule };
  const nextRule = { ...event.recurrenceRule };
  if (originalRule.count !== undefined) {
    originalRule.count = before;
    nextRule.count = event.recurrenceRule.count! - before;
    if (nextRule.count <= 0) throw new InvalidSplitError('Split point is beyond the recurrence count');
  } else {
    const last = ids.slice(0, index).findLast((date) => event.recurrenceOverrides?.[date]?.excluded !== true);
    if (!last) throw new InvalidSplitError('No occurrence remains before the split point');
    originalRule.until = last;
  }
  const original = fromJSCalendar({ ...event, updated: now.toString({ smallestUnit: 'second' }), sequence: (event.sequence ?? 0) + 1, recurrenceRule: originalRule, recurrenceOverrides: earlier,
    relatedTo: { ...event.relatedTo, [newUid]: { relation: { next: true } } } }, resource, now);
  const next = fromJSCalendar({ ...event, uid: newUid, start: at, created: now.toString({ smallestUnit: 'second' }), updated: now.toString({ smallestUnit: 'second' }), sequence: 0, recurrenceRule: nextRule, recurrenceOverrides: later,
    relatedTo: { ...event.relatedTo, [resource.uid]: { relation: { first: true } } } }, { ...resource, uid: newUid, master: resource.master, overrides: resource.overrides }, now);
  return { original, next };
}
