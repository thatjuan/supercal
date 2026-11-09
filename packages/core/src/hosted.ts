import { getProp, recurrenceId, tzidsOf } from './accessors.ts';
import { componentsOf, parseCalendar, splitTopLevel } from './ical.ts';
import type { EventResource } from './model.ts';
import { assertIanaZone, spanOf } from './time.ts';

export const MAX_OBJECT_BYTES = 1024 * 1024;
export type ObjectRejection = 'invalid-calendar-data' | 'unsupported-component' | 'invalid-object' | 'too-large';

/** Validates a complete hosted object before its raw payload can become authoritative. */
export function validateObject(payload: string): { ok: true; resource: EventResource } | { ok: false; code: ObjectRejection; detail: string } {
  const reject = (code: ObjectRejection, detail: string) => ({ ok: false as const, code, detail });
  if (new TextEncoder().encode(payload).length > MAX_OBJECT_BYTES) return reject('too-large', 'Object exceeds 1 MiB');
  try {
    const lines = payload.replace(/\r\n?/g, '\n').split(/\n(?![ \t])/).filter((line) => line.trim());
    const stack: string[] = [];
    let calendars = 0;
    for (const line of lines) {
      const begin = /^BEGIN:(.+)$/i.exec(line.trim())?.[1]?.toLowerCase();
      const end = /^END:(.+)$/i.exec(line.trim())?.[1]?.toLowerCase();
      if (begin) {
        if (stack.length === 0 && (begin !== 'vcalendar' || ++calendars !== 1)) throw new Error('Expected one VCALENDAR');
        stack.push(begin);
      } else if (end) {
        if (stack.pop() !== end) throw new Error('Mismatched component boundary');
      } else if (!stack.length) throw new Error('Data outside VCALENDAR');
    }
    if (stack.length || calendars !== 1) throw new Error('Incomplete VCALENDAR');
    const top = splitTopLevel(payload);
    if (top.blocks.some((block) => block.name !== 'vevent' && block.name !== 'vtimezone')) return reject('unsupported-component', 'Only VEVENT and VTIMEZONE are supported');
    if (top.calendarLines.some((line) => /^METHOD[;:]/i.test(line))) return reject('invalid-object', 'METHOD is not allowed');
    const parsed = parseCalendar(payload);
    if (parsed.errors.length) return reject('invalid-calendar-data', parsed.errors.map((error) => error.message).join('; '));
    const [resource] = parsed.resources;
    if (!resource || parsed.resources.length !== 1) return reject('invalid-object', 'Object must contain VEVENTs with exactly one UID');
    for (const component of componentsOf(resource)) {
      if (!getProp(component, 'dtstart')) throw new Error('VEVENT has no DTSTART');
      if (recurrenceId(component) !== null && getProp(component, 'rrule')) throw new Error('An override cannot carry RRULE');
      for (const tzid of tzidsOf(component)) if (!resource.timezones[tzid]) assertIanaZone(tzid);
    }
    spanOf(resource);
    return { ok: true, resource };
  } catch (error) {
    return reject('invalid-calendar-data', error instanceof Error ? error.message : String(error));
  }
}
