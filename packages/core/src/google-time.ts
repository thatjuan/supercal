/** Shared iCalendar time conversion for Google event writers. */
import { Temporal } from '@js-temporal/polyfill';
import { getProp, propParam, propType } from './accessors.ts';
import { vtimezoneUtcOffset } from './ical.ts';
import { assertIanaZone } from './time.ts';
import type { EventResource, JCalComponent, JCalProperty } from './model.ts';

/** A Google all-day date or zoned event time. */
export type GoogleTime = { date: string } | { dateTime: string; timeZone?: string };

/** Whether a TZID can be sent to Google without resolving a supplied VTIMEZONE. */
function isIana(zone: string): boolean {
  try {
    assertIanaZone(zone);
    return true;
  } catch {
    return false;
  }
}

/** A DATE or DATE-TIME property as a Google time. Floating times are read in `zone`; a non-IANA TZID is resolved through the resource's VTIMEZONE to UTC. */
export function googleTime(prop: JCalProperty, resource: EventResource, zone: string): GoogleTime {
  const value = String(prop[3]);
  if (propType(prop) === 'date') return { date: value };
  if (value.endsWith('Z')) return { dateTime: value };
  const tzid = propParam(prop, 'tzid');
  if (tzid && isIana(tzid)) return { dateTime: value, timeZone: tzid };
  const vtimezone = tzid ? resource.timezones[tzid] : undefined;
  if (vtimezone) {
    const wall = Temporal.PlainDateTime.from(value);
    return { dateTime: wall.toZonedDateTime('UTC').toInstant().subtract({ seconds: vtimezoneUtcOffset(vtimezone, wall) }).toString() };
  }
  return { dateTime: value, timeZone: zone };
}

/** DTEND, else DTSTART + DURATION, else the RFC 5545 default (one day for a date, zero length otherwise). */
export function googleEndTime(component: JCalComponent, start: GoogleTime, resource: EventResource, zone: string): GoogleTime {
  const dtend = getProp(component, 'dtend');
  if (dtend) return googleTime(dtend, resource, zone);
  const raw = getProp(component, 'duration')?.[3];
  const duration = typeof raw === 'string' ? Temporal.Duration.from(raw) : null;
  if ('date' in start) return { date: Temporal.PlainDate.from(start.date).add(duration ?? { days: 1 }).toString() };
  if (!duration) return start;
  if (start.dateTime.endsWith('Z') || /[+-]\d\d:\d\d$/.test(start.dateTime)) return { ...start, dateTime: Temporal.Instant.from(start.dateTime).toZonedDateTimeISO(start.timeZone ?? 'UTC').add(duration).toInstant().toString() };
  return { ...start, dateTime: Temporal.PlainDateTime.from(start.dateTime).add(duration).toString({ smallestUnit: 'second' }) };
}

