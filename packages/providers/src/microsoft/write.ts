/** Pure iCalendar → Graph mapping and ordered replacement planning. */
import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { getProp, getProps, normalizeGraph, googleTime, googleEndTime, graphRrule, htmlToText, propertyLine, propParam, propValues, status, subcomponents, textValue, transp, GraphEvent, type EventResource, type GraphRecurrence, type GoogleTime, type JCalComponent } from '@supercal/core';
import { ProviderWriteRejectedError, type StoredObject } from '../adapter.ts';

/** Only the fields a device can represent; unrelated Outlook fields remain untouched. */
export type GraphBody = {
  subject: string;
  body?: { contentType: 'text' | 'html'; content: string };
  location: { displayName: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  recurrence?: GraphRecurrence | null;
  showAs: 'free' | 'tentative' | 'busy';
  sensitivity: 'private' | 'confidential' | 'normal';
  isReminderOn: boolean;
  reminderMinutesBeforeStart?: number;
  attendees: { emailAddress: { address: string; name?: string }; type: 'optional' | 'required' }[];
};
/** Masters precede occurrence updates, with cancellations last. */
export type GraphWriteOp =
  | { op: 'create'; body: GraphBody; transactionId: string }
  | { op: 'patch'; id: string; etag: string; body: Partial<GraphBody> }
  | { op: 'instance'; masterId: string; originalStart: string; body: Partial<GraphBody> | null };

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const INDEX = ['first', 'second', 'third', 'fourth', 'last'] as const;

/** Stable UUIDv5 in the URL namespace: Graph deduplicates retries of the same client UID. */
export function graphTransactionId(uid: string): string {
  const digest = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')).update(uid).digest();
  digest[6] = ((digest[6] ?? 0) & 15) | 80;
  digest[8] = ((digest[8] ?? 0) & 63) | 128;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Google and Graph share the same iCalendar time semantics, but Graph requires local times. */
function graphTime(time: GoogleTime, zone: string): GraphBody['start'] {
  if ('date' in time) return { dateTime: `${time.date}T00:00:00`, timeZone: zone };
  if (time.dateTime.endsWith('Z') || /[+-]\d\d:\d\d$/.test(time.dateTime)) return { dateTime: Temporal.Instant.from(time.dateTime).toZonedDateTimeISO('UTC').toPlainDateTime().toString({ smallestUnit: 'second' }), timeZone: 'UTC' };
  return { dateTime: time.dateTime, timeZone: time.timeZone ?? zone };
}

/** Canonical instant key for stored original starts and device recurrence IDs. */
export function graphSlot(time: GraphBody['start']): string {
  return Temporal.PlainDateTime.from(time.dateTime.replace(/Z$/, '')).toZonedDateTime(time.timeZone).toInstant().toString();
}

/** Refuse every rule that Graph cannot represent exactly, before a provider request. */
function recurrence(component: JCalComponent, start: GraphBody['start'], allDay: boolean): GraphRecurrence | null {
  const rules = getProps(component, 'rrule');
  const reject = (reason: string): never => { throw new ProviderWriteRejectedError('invalid-data', `Graph cannot represent recurrence (${reason}): ${rules.map(propertyLine).join(' | ')}`); };
  if (rules.length > 1 || getProps(component, 'rdate').length) reject('multiple RRULEs or RDATE');
  if (!rules.length) return null;
  const parts: Record<string, string | undefined> = Object.fromEntries(propertyLine(rules[0]!).split(':').slice(1).join(':').split(';').map((p) => p.split('=')));
  const freq = parts.FREQ;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) reject('frequency');
  if (parts.COUNT && parts.UNTIL) reject('COUNT with UNTIL');
  if (Object.keys(parts).some((key) => !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST', 'COUNT', 'UNTIL'].includes(key))) reject('unsupported rule part');
  const date = Temporal.PlainDateTime.from(start.dateTime).toPlainDate();
  const pattern: GraphRecurrence['pattern'] = { type: 'daily', interval: Number(parts.INTERVAL ?? 1) };
  if (!Number.isInteger(pattern.interval) || pattern.interval < 1) reject('interval');
  const monthDays = parts.BYMONTHDAY?.split(',');
  const months = parts.BYMONTH?.split(',');
  if ((monthDays?.length ?? 0) > 1 || (months?.length ?? 0) > 1) reject('multiple month days or months');
  if ((monthDays || months) && ['DAILY', 'WEEKLY'].includes(freq!)) reject('month filter on daily/weekly');
  if (months && freq !== 'YEARLY') reject('BYMONTH outside yearly');
  let ordinal: number | undefined;
  const days = parts.BYDAY?.split(',').map((raw) => {
    const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw);
    if (!match) return reject('BYDAY');
    if (match[1]) ordinal = Number(match[1]);
    return DAYS[DAY_CODES.indexOf(match[2]!)]!;
  });
  if (freq === 'DAILY' && days) reject('daily BYDAY');
  if (freq === 'WEEKLY') {
    if (ordinal !== undefined) reject('ordinal weekly BYDAY');
    pattern.type = 'weekly'; pattern.daysOfWeek = days ?? [DAYS[date.dayOfWeek % 7]!];
    pattern.firstDayOfWeek = DAYS[DAY_CODES.indexOf(parts.WKST ?? 'MO')] ?? reject('WKST');
  }
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    if (days) {
      if (days.length !== 1 || monthDays) reject('relative rule with multiple days or BYMONTHDAY');
      const position = Number(parts.BYSETPOS ?? ordinal);
      if (ordinal !== undefined && parts.BYSETPOS) reject('ordinal BYDAY with BYSETPOS');
      const index = INDEX[[1, 2, 3, 4, -1].indexOf(position)];
      if (!index) reject('relative position');
      pattern.type = freq === 'MONTHLY' ? 'relativeMonthly' : 'relativeYearly';
      pattern.daysOfWeek = days; pattern.index = index!;
    } else {
      pattern.type = freq === 'MONTHLY' ? 'absoluteMonthly' : 'absoluteYearly';
      pattern.dayOfMonth = Number(monthDays?.[0] ?? date.day);
      if (pattern.dayOfMonth < 1 || pattern.dayOfMonth > 31) reject('month day');
    }
    if (freq === 'YEARLY') pattern.month = Number(months?.[0] ?? date.month);
  }
  if (parts.BYSETPOS && !['relativeMonthly', 'relativeYearly'].includes(pattern.type)) reject('BYSETPOS outside relative monthly/yearly');
  const range: GraphRecurrence['range'] = { type: parts.COUNT ? 'numbered' : parts.UNTIL ? 'endDate' : 'noEnd', startDate: date.toString(), recurrenceTimeZone: start.timeZone };
  if (parts.COUNT) range.numberOfOccurrences = Number(parts.COUNT);
  if (parts.UNTIL) {
    const raw = parts.UNTIL;
    const iso = raw.replace(/^(\d{4})(\d{2})(\d{2})/, '$1-$2-$3').replace(/T(\d{2})(\d{2})(\d{2})/, 'T$1:$2:$3');
    let last = allDay ? Temporal.PlainDate.from(iso) : Temporal.Instant.from(iso).toZonedDateTimeISO(start.timeZone).toPlainDate();
    if (!allDay && Temporal.Instant.compare(Temporal.Instant.from(iso), Temporal.PlainDateTime.from(`${last}T${Temporal.PlainDateTime.from(start.dateTime).toPlainTime()}`).toZonedDateTime(start.timeZone).toInstant()) < 0) last = last.subtract({ days: 1 });
    range.endDate = last.toString();
  }
  try { graphRrule({ pattern, range }, { zone: start.timeZone, allDay }); } catch (error) { reject(String(error)); }
  return { pattern, range };
}

/** Map one VEVENT, preserving an unchanged Outlook HTML body. */
export function graphEventBody(component: JCalComponent, resource: EventResource, zone: string, existing?: GraphEvent): GraphBody {
  const prop = getProp(component, 'dtstart');
  if (!prop) throw new ProviderWriteRejectedError('invalid-data', 'VEVENT has no DTSTART');
  const time = googleTime(prop, resource, zone);
  const description = textValue(component, 'description') ?? '';
  const body: GraphBody = {
    subject: textValue(component, 'summary') ?? '',
    ...(existing?.body?.contentType === 'html' && description === htmlToText(existing.body.content ?? '') ? {} : { body: { contentType: 'text', content: description } }),
    location: { displayName: textValue(component, 'location') ?? '' },
    start: graphTime(time, zone), end: graphTime(googleEndTime(component, time, resource, zone), zone), isAllDay: 'date' in time,
    showAs: transp(component) === 'TRANSPARENT' ? 'free' : status(component) === 'TENTATIVE' ? 'tentative' : 'busy',
    sensitivity: textValue(component, 'class')?.toUpperCase() === 'PRIVATE' ? 'private' : textValue(component, 'class')?.toUpperCase() === 'CONFIDENTIAL' ? 'confidential' : 'normal',
    isReminderOn: false,
    attendees: getProps(component, 'attendee').flatMap((p) => typeof p[3] === 'string' && /^mailto:/i.test(p[3]) ? [{ emailAddress: { address: p[3].slice(7), ...(propParam(p, 'cn') && { name: propParam(p, 'cn')! }) }, type: propParam(p, 'role')?.toUpperCase() === 'OPT-PARTICIPANT' ? 'optional' : 'required' }] : []),
  };
  for (const alarm of subcomponents(component, 'valarm')) {
    const trigger = getProp(alarm, 'trigger');
    if (!trigger || trigger[2] !== 'duration' || typeof trigger[3] !== 'string' || (propParam(trigger, 'related') ?? 'START').toUpperCase() !== 'START') continue;
    const minutes = -Temporal.Duration.from(trigger[3]).total('minutes');
    if (Number.isInteger(minutes) && minutes > 0) { body.isReminderOn = true; body.reminderMinutesBeforeStart = minutes; break; }
  }
  return body;
}

/** Convert only the time fields to UTC for mailboxes rejecting IANA zone names. */
export function graphUtcBody(body: Partial<GraphBody>): Partial<GraphBody> {
  const utc = (time: GraphBody['start']) => ({ dateTime: body.isAllDay ? time.dateTime : graphSlot(time).replace(/Z$/, ''), timeZone: 'UTC' });
  return { ...body, ...(body.start && { start: utc(body.start) }), ...(body.end && { end: utc(body.end) }), ...(body.isAllDay && body.recurrence && { recurrence: { ...body.recurrence, range: { ...body.recurrence.range, recurrenceTimeZone: 'UTC' } } }) };
}

/** Restore inherited master fields at an occurrence's original wall time, preserving DST duration. */
function shifted(body: GraphBody, original: string): GraphBody {
  const start = Temporal.PlainDateTime.from(body.start.dateTime);
  const end = Temporal.PlainDateTime.from(body.end.dateTime);
  const slot = Temporal.Instant.from(original).toZonedDateTimeISO(body.start.timeZone).toPlainDateTime();
  const { recurrence: _recurrence, ...fields } = body;
  return { ...fields, start: { ...body.start, dateTime: slot.toString() }, end: { ...body.end, dateTime: slot.add(start.until(end)).toString() } };
}

/** Compare mapped values rather than Graph's extra defaults and provider-only fields. */
function graphPatch(body: GraphBody, previous: GraphBody): Partial<GraphBody> {
  const patch = Object.fromEntries(Object.entries(body).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof GraphBody])));
  return 'start' in patch || 'end' in patch ? { ...patch, start: body.start, end: body.end, isAllDay: body.isAllDay } : patch;
}

/** Plan the entire UID group without I/O so an invalid recurrence cannot partly save. */
export function graphWriteOps(resource: EventResource, existing: StoredObject[], zone: string): GraphWriteOp[] {
  const stored = existing.map((object) => ({ ...object, event: GraphEvent.parse(object.payload) }));
  const master = stored.find(({ event }) => !event.seriesMasterId);
  const previousResource = master ? normalizeGraph([{ id: master.id, etag: master.etag, groupUid: resource.uid, payload: JSON.stringify(master.event) }])?.resource : undefined;
  const component = resource.master ?? previousResource?.master;
  if (!component) throw new ProviderWriteRejectedError('invalid-data', 'A new Graph event needs a master');
  const body = graphEventBody(component, resource.master ? resource : previousResource!, zone, master?.event);
  body.recurrence = recurrence(component, body.start, body.isAllDay);
  const operations: GraphWriteOp[] = [];
  if (resource.master) {
    if (!master) operations.push({ op: 'create', body, transactionId: graphTransactionId(resource.uid) });
    else {
      if (!previousResource?.master) throw new ProviderWriteRejectedError('invalid-data', 'Stored Graph event has no master');
      const previous = graphEventBody(previousResource.master, previousResource, zone, master.event);
      previous.recurrence = recurrence(previousResource.master, previous.start, previous.isAllDay);
      const patch = graphPatch(body, previous);
      if (Object.keys(patch).length) operations.push({ op: 'patch', id: master.id, etag: master.etag, body: patch });
    }
  }
  const touched = new Set<string>();
  const cancellations: GraphWriteOp[] = [];
  const masterId = master?.id ?? '';
  const oldExcluded = new Set((master?.event['@supercal.cancelled'] ?? []).flatMap((c) => c.originalStart ? [Temporal.Instant.from(c.originalStart).toString()] : []));
  for (const component of resource.overrides) {
    const rid = getProp(component, 'recurrence-id');
    if (!rid) continue;
    if (getProps(component, 'rrule').length || getProps(component, 'rdate').length) throw new ProviderWriteRejectedError('invalid-data', 'Graph overrides cannot have recurrence rules');
    const originalStart = graphSlot(graphTime(googleTime(rid, resource, zone), zone));
    touched.add(originalStart);
    if (status(component) === 'CANCELLED' && oldExcluded.has(originalStart)) continue;
    const previous = stored.find(({ event }) => event.originalStart && Temporal.Instant.from(event.originalStart).equals(Temporal.Instant.from(originalStart)));
    const op: GraphWriteOp = { op: 'instance', masterId, originalStart, body: status(component) === 'CANCELLED' ? null : graphEventBody(component, resource, zone, previous?.event ?? master?.event) };
    (op.body ? operations : cancellations).push(op);
  }
  for (const prop of (resource.master ? getProps(resource.master, 'exdate') : [])) for (const value of propValues(prop)) {
    const originalStart = graphSlot(graphTime(googleTime([prop[0], prop[1], prop[2], value], resource, zone), zone));
    if (!touched.has(originalStart) && !oldExcluded.has(originalStart)) cancellations.push({ op: 'instance', masterId, originalStart, body: null });
    touched.add(originalStart);
  }
  for (const previous of stored) if (resource.master && previous.event.seriesMasterId && previous.event.originalStart) {
    const originalStart = Temporal.Instant.from(previous.event.originalStart).toString();
    if (!touched.has(originalStart)) {
      const inherited = body.body === undefined && master?.event.body?.contentType === 'html'
        ? { ...body, body: { contentType: 'html' as const, content: master.event.body.content ?? '' } } : body;
      operations.push({ op: 'instance', masterId, originalStart, body: shifted(inherited, originalStart) });
    }
  }
  return [...operations, ...cancellations];
}
