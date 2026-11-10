/** Pure iCalendar → Google field diffs and ordered series/instance write planning. */
import { Temporal } from '@js-temporal/polyfill';
import { GoogleEvent, normalizeGoogle, getProp, getProps, googleTime, googleEndTime, propertyLine, propParam, propValues, status, subcomponents, textValue, transp, type EventResource, type GoogleTime, type JCalComponent } from '@supercal/core';
import { z } from 'zod';
import { ProviderWriteRejectedError, type StoredObject } from '../adapter.ts';

/** Whether Google should notify participants of a mutation. */
export type SendUpdates = 'all' | 'none';
/** Fields represented by iCalendar; PATCH never replaces unrelated Google fields. */
export type GoogleEventBody = {
  iCalUID?: string;
  summary: string;
  description: string;
  location: string;
  start: GoogleTime;
  end: GoogleTime;
  recurrence?: string[];
  status: 'confirmed' | 'tentative' | 'cancelled';
  transparency: 'opaque' | 'transparent';
  visibility: 'default' | 'private' | 'confidential' | 'public';
  reminders?: { useDefault: boolean; overrides?: { method: 'popup' | 'email'; minutes: number }[] };
  attendees: { email: string; displayName?: string; optional?: boolean; responseStatus?: string; self?: boolean | undefined; organizer?: boolean; resource?: boolean; comment?: string; additionalGuests?: number }[];
};
/** Master operations precede instance operations; deletions run last. */
export type GoogleWriteOp =
  | { op: 'import'; body: GoogleEventBody }
  | { op: 'patch'; eventId: string; etag: string; body: Partial<GoogleEventBody>; sendUpdates: SendUpdates }
  | { op: 'patchInstance'; masterId: string; originalStart: GoogleTime; body: Partial<GoogleEventBody>; sendUpdates: SendUpdates }
  | { op: 'delete'; eventId: string; etag: string; sendUpdates: SendUpdates };

/** Stored fields needed for conditions, default alarms and notification decisions. */
export const StoredGoogleEvent = GoogleEvent.extend({
  etag: z.string().optional(),
  organizer: z.object({ self: z.boolean().optional() }).passthrough().optional(),
  attendees: z.array(z.object({ email: z.string().optional(), self: z.boolean().optional(), responseStatus: z.string().optional() }).passthrough()).optional(),
  reminders: z.object({ useDefault: z.boolean().optional(), overrides: z.array(z.object({ method: z.enum(['popup', 'email']), minutes: z.number() })).optional() }).optional(),
}).passthrough();
export type StoredGoogleEvent = z.infer<typeof StoredGoogleEvent>;

const PARTSTAT: Record<string, string> = { 'NEEDS-ACTION': 'needsAction', ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative' };
const ComparableAttendees = z.array(z.object({ email: z.string().optional(), displayName: z.string().optional(), optional: z.boolean().default(false), responseStatus: z.string().default('needsAction') }));

/** Compare mapped attendee fields with Google's defaults and address ordering. */
function comparableAttendees(items: unknown) {
  return ComparableAttendees.parse(items).sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));
}

const VISIBILITY: Record<string, GoogleEventBody['visibility']> = { PRIVATE: 'private', CONFIDENTIAL: 'confidential', PUBLIC: 'public' };

/** Canonical instant/date key, independent of offset spelling. */
export function googleSlot(time: { date?: string | undefined; dateTime?: string | undefined; timeZone?: string | undefined }, zone = 'UTC'): string {
  if (time.date) return time.date;
  if (!time.dateTime) throw new RangeError('Google time has no value');
  try { return Temporal.Instant.from(time.dateTime).toString(); }
  catch { return Temporal.PlainDateTime.from(time.dateTime).toZonedDateTime(time.timeZone ?? zone).toInstant().toString(); }
}

/** Google's deterministic occurrence id, in UTC for timed series. */
export function googleInstanceId(masterId: string, originalStart: GoogleTime): string {
  return `${masterId}_${googleSlot(originalStart).replace(/[-:]/g, '')}`;
}

/** Relative before-start alarms supported by Google, rejecting silent truncation. */
function reminders(component: JCalComponent, existing?: StoredGoogleEvent): GoogleEventBody['reminders'] {
  const alarms = subcomponents(component, 'valarm');
  if (!alarms.length && existing?.reminders?.useDefault) return undefined;
  const overrides: NonNullable<GoogleEventBody['reminders']>['overrides'] = [];
  for (const alarm of alarms) {
    const trigger = getProp(alarm, 'trigger');
    const action = textValue(alarm, 'action')?.toUpperCase();
    if (!trigger || typeof trigger[3] !== 'string' || (propParam(trigger, 'related') ?? 'START').toUpperCase() !== 'START' || !['DISPLAY', 'EMAIL'].includes(action ?? '')) continue;
    try {
      const minutes = -Temporal.Duration.from(trigger[3]).total('minutes');
      if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 40320) overrides.push({ method: action === 'EMAIL' ? 'email' : 'popup', minutes });
    } catch { /* Absolute and unsupported triggers have no Google equivalent. */ }
  }
  if (overrides.length > 5) throw new ProviderWriteRejectedError('invalid-data', 'Google supports at most five reminders per event');
  return { useDefault: false, overrides };
}

/** Convert one component, retaining provider metadata on attendees with the same address. */
export function googleEventBody(component: JCalComponent, resource: EventResource, zone: string, existing?: StoredGoogleEvent): GoogleEventBody {
  const dtstart = getProp(component, 'dtstart');
  if (!dtstart) throw new ProviderWriteRejectedError('invalid-data', 'VEVENT has no DTSTART');
  const start = googleTime(dtstart, resource, zone);
  const alarm = reminders(component, existing);
  return {
    summary: textValue(component, 'summary') ?? '',
    description: textValue(component, 'description') ?? '',
    location: textValue(component, 'location') ?? '',
    start, end: googleEndTime(component, start, resource, zone),
    status: status(component) === 'CANCELLED' ? 'cancelled' : status(component) === 'TENTATIVE' ? 'tentative' : 'confirmed',
    transparency: transp(component) === 'TRANSPARENT' ? 'transparent' : 'opaque',
    visibility: VISIBILITY[textValue(component, 'class')?.toUpperCase() ?? ''] ?? 'default',
    ...(alarm && { reminders: alarm }),
    attendees: getProps(component, 'attendee').flatMap((p) => {
      const email = typeof p[3] === 'string' && /^mailto:/i.test(p[3]) ? p[3].slice(7) : null;
      if (!email) return [];
      const previous = existing?.attendees?.find((a) => a.email?.toLowerCase() === email.toLowerCase());
      const { displayName: _name, optional: _optional, responseStatus: _response, ...metadata } = previous ?? {};
      const cn = propParam(p, 'cn');
      return [{ ...metadata, email, ...(cn && { displayName: cn }), optional: propParam(p, 'role')?.toUpperCase() === 'OPT-PARTICIPANT', responseStatus: PARTSTAT[propParam(p, 'partstat')?.toUpperCase() ?? ''] ?? 'needsAction' }];
    }),
  };
}

/** Stable comparison without object-key ordering or omitted Google default fields causing spurious patches. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === 'object') return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return JSON.stringify(value);
}

/** Only changed mapped fields; unchanged reminders and unknown provider fields stay untouched. */
export function googlePatch(body: Partial<GoogleEventBody>, existing: StoredGoogleEvent): Partial<GoogleEventBody> {
  const defaults: Record<string, unknown> = { summary: '', description: '', location: '', recurrence: [], attendees: [], status: 'confirmed', transparency: 'opaque', visibility: 'default', reminders: { useDefault: false, overrides: [] } };
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => {
    const previous = existing[key] ?? defaults[key];
    if ((key === 'start' || key === 'end') && previous && typeof previous === 'object') {
      const parsed = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }).parse(previous);
      const next = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }).parse(value);
      return googleSlot(parsed) !== googleSlot(next) || (parsed.timeZone !== undefined && parsed.timeZone !== (next.timeZone ?? 'UTC'));
    }
    if (key === 'recurrence') return canonical([...z.array(z.string()).parse(value)].sort()) !== canonical([...z.array(z.string()).parse(previous)].sort());
    if (key === 'reminders') {
      const schema = z.object({ useDefault: z.boolean().default(false), overrides: z.array(z.object({ method: z.string(), minutes: z.number() })).default([]) });
      return canonical(schema.parse(value)) !== canonical(schema.parse(previous));
    }
    if (key === 'attendees') {
      return canonical(comparableAttendees(value)) !== canonical(comparableAttendees(previous));
    }
    return canonical(value) !== canonical(previous);
  }));
}

/** Notify participants for organizer scheduling changes or a reply changing only our own PARTSTAT. */
export function googleSendUpdates(existing: StoredGoogleEvent, patch: Partial<GoogleEventBody>): SendUpdates {
  const keys = Object.keys(patch);
  if (existing.organizer?.self && existing.attendees?.some((a) => !a.self) && keys.some((key) => ['start', 'end', 'recurrence', 'location', 'attendees', 'status'].includes(key))) return 'all';
  if (keys.length === 1 && keys[0] === 'attendees' && patch.attendees && patch.attendees.length === existing.attendees?.length) {
    let reply = false;
    const same = comparableAttendees(patch.attendees).every((next) => {
      const prev = existing.attendees?.find((attendee) => attendee.email === next.email);
      if (!prev) return false;
      const before = comparableAttendees([prev])[0];
      if (prev.self && prev.responseStatus !== next.responseStatus) {
        reply = true;
        return canonical({ ...before, responseStatus: next.responseStatus }) === canonical(next);
      }
      return canonical(before) === canonical(next);
    });
    if (same && reply) return 'all';
  }
  return 'none';
}

/** Master times shifted to a recurrence slot, retaining wall-clock duration across DST. */
function shifted(body: GoogleEventBody, original: GoogleTime): GoogleEventBody {
  if ('date' in body.start && 'date' in body.end && 'date' in original) {
    const duration = Temporal.PlainDate.from(body.start.date).until(body.end.date);
    return { ...body, start: original, end: { date: Temporal.PlainDate.from(original.date).add(duration).toString() }, status: 'confirmed' };
  }
  const zone = 'dateTime' in body.start ? body.start.timeZone ?? 'UTC' : 'UTC';
  const start = Temporal.Instant.from(googleSlot(body.start)).toZonedDateTimeISO(zone).toPlainDateTime();
  const end = Temporal.Instant.from(googleSlot(body.end)).toZonedDateTimeISO(zone).toPlainDateTime();
  const slot = Temporal.Instant.from(googleSlot(original)).toZonedDateTimeISO(zone).toPlainDateTime();
  return { ...body, start: { dateTime: slot.toString(), timeZone: zone }, end: { dateTime: slot.add(start.until(end)).toString(), timeZone: zone }, status: 'confirmed' };
}

/** Excluded slots with their original value type and TZID. */
function excluded(component: JCalComponent | null, resource: EventResource, zone: string): GoogleTime[] {
  return component ? getProps(component, 'exdate').flatMap((prop) => propValues(prop).map((value) => googleTime([prop[0], prop[1], prop[2], value], resource, zone))) : [];
}

/** Plan a full UID-group replacement without I/O. An empty master id refers to the preceding import result. */
export function googleWriteOps(resource: EventResource, existing: StoredObject[], zone: string): GoogleWriteOp[] {
  const stored = existing.map((object) => ({ ...object, event: StoredGoogleEvent.parse(object.payload) }));
  const master = stored.find(({ event }) => !event.recurringEventId);
  const masterId = master?.id ?? '';
  const previousResource = master ? normalizeGoogle([{ id: master.id, etag: master.etag, groupUid: resource.uid, payload: JSON.stringify(master.event) }])?.resource : undefined;
  const operations: GoogleWriteOp[] = [];
  let body: GoogleEventBody | undefined;
  if (resource.master) {
    body = { ...googleEventBody(resource.master, resource, zone, master?.event), recurrence: ['rrule', 'exdate', 'rdate'].flatMap((name) => getProps(resource.master!, name)).map(propertyLine) };
    if (!master) operations.push({ op: 'import', body: { ...body, iCalUID: resource.uid } });
    else {
      const patch = googlePatch(body, master.event);
      if (Object.keys(patch).length) operations.push({ op: 'patch', eventId: master.id, etag: master.etag, body: patch, sendUpdates: googleSendUpdates(master.event, patch) });
    }
  } else if (!master) throw new ProviderWriteRejectedError('invalid-data', 'A new Google event needs a master');
  const touched = new Set<string>();
  /** Queue a stored exception diff or a change from the inherited occurrence. */
  const instance = (originalStart: GoogleTime, next: Partial<GoogleEventBody>) => {
    const slot = googleSlot(originalStart, zone);
    touched.add(slot);
    const previous = stored.find(({ event }) => event.recurringEventId && event.originalStartTime && googleSlot(event.originalStartTime, zone) === slot);
    if (previous) {
      const patch = googlePatch(next, previous.event);
      if (Object.keys(patch).length) operations.push({ op: 'patch', eventId: previous.id, etag: previous.etag, body: patch, sendUpdates: googleSendUpdates(previous.event, patch) });
    } else {
      const inherited = body ?? (previousResource?.master ? googleEventBody(previousResource.master, previousResource, zone, master?.event) : undefined);
      const baseline = inherited ? StoredGoogleEvent.parse({ ...master?.event, ...shifted(inherited, originalStart), status: inherited.status, id: masterId }) : undefined;
      const patch = baseline ? googlePatch(next, baseline) : next;
      if (Object.keys(patch).length) operations.push({ op: 'patchInstance', masterId, originalStart, body: patch, sendUpdates: master ? googleSendUpdates(master.event, patch) : 'none' });
    }
  };
  for (const component of resource.overrides) {
    const rid = getProp(component, 'recurrence-id');
    if (!rid) continue;
    const original = googleTime(rid, resource, zone);
    const previous = stored.find(({ event }) => event.originalStartTime && googleSlot(event.originalStartTime, zone) === googleSlot(original, zone));
    instance(original, status(component) === 'CANCELLED' ? { status: 'cancelled' } : googleEventBody(component, resource, zone, previous?.event ?? master?.event));
  }
  const previousExclusions = new Set(previousResource ? excluded(previousResource.master, previousResource, zone).map((time) => googleSlot(time, zone)) : []);
  const exclusions = excluded(resource.master, resource, zone);
  const excludedSlots = new Set(exclusions.map((time) => googleSlot(time, zone)));
  for (const original of exclusions) if (!touched.has(googleSlot(original, zone)) && !previousExclusions.has(googleSlot(original, zone))) instance(original, { status: 'cancelled' });
  if (body) for (const previous of stored) {
    const original = previous.event.originalStartTime;
    if (!previous.event.recurringEventId || !original || touched.has(googleSlot(original, zone)) || excludedSlots.has(googleSlot(original, zone))) continue;
    const time: GoogleTime = original.date ? { date: original.date } : { dateTime: original.dateTime!, ...(original.timeZone && { timeZone: original.timeZone }) };
    const reverted = shifted(body, time);
    const { recurrence: _recurrence, ...fields } = reverted;
    instance(time, fields);
  }
  return operations;
}
