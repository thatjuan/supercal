import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { assertIanaZone } from '../time.ts';

// Unknown object fields stay loose; known names still obey the draft's case and naming rules.
const vendorName = /^(?:[^\x00-\x20\x7f:./~"-](?:[^\x00-\x20\x7f:./~"]*[^\x00-\x20\x7f:./~"-])?)(?:\.[^\x00-\x20\x7f:./~"-](?:[^\x00-\x20\x7f:./~"]*[^\x00-\x20\x7f:./~"-])?)*:[^\x00-\x08\x0a-\x1f\x7f"/~]+$/;
const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape).superRefine((value, ctx) => {
  const known = Object.keys(shape);
  for (const key of Object.keys(value)) {
    const expected = known.find((name) => name.toLowerCase() === key.toLowerCase());
    if (expected && expected !== key) ctx.addIssue({ code: 'custom', path: [key], message: `Property names are case-sensitive; use ${expected}` });
    else if (key === 'extra' || (!/^(?:@type|[a-z][A-Za-z0-9]*)$/.test(key) && !vendorName.test(key))) ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid JSCalendar property name' });
  }
});
const extensible = <T extends readonly [string, ...string[]]>(values: T) => z.union([z.enum(values), z.string().regex(vendorName)]);
const valid = (fn: () => unknown) => { try { fn(); return true; } catch { return false; } };
export const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/).refine((v) => valid(() => Temporal.PlainDateTime.from(v)), 'Expected a local date-time');
const UTCDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine((v) => valid(() => Temporal.Instant.from(v)), 'Expected a UTC date-time');
const Zone = z.string().refine((v) => valid(() => assertIanaZone(v)), 'Expected an IANA time zone');
const durationPattern = /^P(?:(?:\d+W(?:\d+D)?|\d+D)(?:T(?:\d+H(?:\d+M(?:\d+S)?)?|\d+M(?:\d+S)?|\d+S))?|T(?:\d+H(?:\d+M(?:\d+S)?)?|\d+M(?:\d+S)?|\d+S))$/;
const Duration = z.string().regex(durationPattern).refine((v) => valid(() => { const d = Temporal.Duration.from(v); if (d.sign < 0 || d.years || d.months) throw new Error(); }), 'Expected a nonnegative duration without years or months');
const day = z.enum(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']);
const intList = (min: number, max: number, nonzero = false) => z.array(z.int().min(min).max(max).refine((v) => !nonzero || v !== 0)).min(1);
export const RecurrenceRule = loose({
  '@type': z.literal('RecurrenceRule').optional(),
  frequency: z.enum(['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly']),
  interval: z.int().min(1).optional(), count: z.int().min(1).optional(), until: LocalDateTime.optional(),
  firstDayOfWeek: day.optional(), rscale: z.string().optional(), skip: z.enum(['omit', 'backward', 'forward']).optional(),
  byDay: z.array(loose({ '@type': z.literal('NDay').optional(), day, nthOfPeriod: z.int().refine((v) => v !== 0).optional() })).min(1).optional(),
  byMonth: z.array(z.string().regex(/^(?:[1-9]|1[0-3])L?$/)).min(1).optional(),
  byMonthDay: intList(-31, 31, true).optional(), byYearDay: intList(-366, 366, true).optional(), byWeekNo: intList(-53, 53, true).optional(),
  byHour: intList(0, 23).optional(), byMinute: intList(0, 59).optional(), bySecond: intList(0, 60).optional(), bySetPosition: intList(-366, 366, true).optional(),
}).refine((v) => !(v.count !== undefined && v.until !== undefined), 'count and until are mutually exclusive');
const map = <T extends z.ZodType>(value: T) => z.record(z.string().min(1), value);
const flags = map(z.literal(true));
const idMap = <T extends z.ZodType>(value: T) => z.record(z.string().regex(/^[A-Za-z0-9_-]{1,255}$/), value);
const Location = loose({ '@type': z.literal('Location').optional(), name: z.string().optional(), description: z.string().optional(), coordinates: z.string().optional(), locationTypes: flags.optional() });
const VirtualLocation = loose({ '@type': z.literal('VirtualLocation').optional(), uri: z.string(), name: z.string().optional(), description: z.string().optional(), features: flags.optional() });
const Link = loose({ '@type': z.literal('Link').optional(), href: z.string(), title: z.string().optional(), contentType: z.string().optional(), size: z.int().nonnegative().optional(), rel: z.string().optional() });
const Participant = loose({
  '@type': z.literal('Participant').optional(), name: z.string().optional(), email: z.string().optional(), calendarAddress: z.string().optional(),
  kind: z.string().optional(), roles: flags.optional(), participationStatus: z.string().optional(), expectReply: z.boolean().optional(),
  delegatedTo: flags.optional(), delegatedFrom: flags.optional(), memberOf: flags.optional(),
});
const Relation = loose({ '@type': z.literal('Relation').optional(), relation: flags.optional() });
const Offset = z.string().refine((v) => durationPattern.test(v.replace(/^[+-]/, '')), 'Expected a signed duration').refine((v) => valid(() => { const d = Temporal.Duration.from(v); if (d.years || d.months) throw new Error(); }), 'Expected an iCalendar duration');
const Alert = loose({ '@type': z.literal('Alert').optional(), action: z.enum(['display', 'email']).default('display'), trigger: z.union([
  loose({ '@type': z.literal('OffsetTrigger').default('OffsetTrigger'), offset: Offset, relativeTo: z.enum(['start', 'end']).optional() }),
  loose({ '@type': z.literal('AbsoluteTrigger'), when: UTCDateTime }),
]), acknowledged: UTCDateTime.optional(), relatedTo: idMap(Relation).optional() });
export type PatchObject = Record<string, unknown>;
export const JSEvent = loose({
  '@type': z.literal('Event'), version: z.literal('2.0').default('2.0'), uid: z.string().min(1).optional(),
  title: z.string().optional(), description: z.string().optional(), descriptionContentType: z.string().optional(), locale: z.string().optional(),
  start: LocalDateTime, duration: Duration.optional(), timeZone: Zone.optional(), endTimeZone: Zone.optional(), showWithoutTime: z.boolean().optional(),
  status: extensible(['confirmed', 'tentative', 'cancelled']).optional(), freeBusyStatus: extensible(['free', 'busy']).optional(), privacy: extensible(['public', 'private', 'secret']).optional(),
  color: z.string().optional(), keywords: flags.optional(), priority: z.int().min(0).max(9).optional(), sequence: z.int().nonnegative().optional(),
  created: UTCDateTime.optional(), updated: UTCDateTime.optional(), prodId: z.string().optional(),
  locations: idMap(Location).optional(), mainLocationId: z.string().optional(), virtualLocations: idMap(VirtualLocation).optional(), links: idMap(Link).optional(),
  participants: idMap(Participant).optional(), organizerCalendarAddress: z.string().optional(),
  recurrenceRule: RecurrenceRule.optional(), recurrenceOverrides: z.record(LocalDateTime, z.record(z.string(), z.unknown())).optional(),
  recurrenceId: LocalDateTime.optional(), recurrenceIdTimeZone: Zone.optional(), relatedTo: map(Relation).optional(), alerts: idMap(Alert).optional(),
}).superRefine((v, ctx) => {
  if (v.endTimeZone && !v.timeZone) ctx.addIssue({ code: 'custom', path: ['endTimeZone'], message: 'endTimeZone requires timeZone' });
  if (v.mainLocationId && !v.locations?.[v.mainLocationId]) ctx.addIssue({ code: 'custom', path: ['mainLocationId'], message: 'mainLocationId must name an existing location' });
  for (const key of ['recurrenceRules', 'excludedRecurrenceRules', 'timeZones', 'method', 'extra', 'excluded']) {
    if (Object.hasOwn(v, key)) ctx.addIssue({ code: 'custom', path: [key], message: key === 'recurrenceRules' ? 'JSCalendar 2.0 uses recurrenceRule instead of recurrenceRules' : `${key} is not supported in JSCalendar 2.0 events` });
  }
  for (const key of Object.keys(v)) {
    const known = Object.keys(JSEvent.shape).find((n) => n.toLowerCase() === key.toLowerCase());
    if (known && known !== key) ctx.addIssue({ code: 'custom', path: [key], message: `Property names are case-sensitive; use ${known}` });
  }
});
export type JSEvent = z.infer<typeof JSEvent>;
export const JSGroup = z.object({ '@type': z.literal('Group'), version: z.literal('2.0'), uid: z.string(), entries: z.array(JSEvent) });
export type JSGroup = z.infer<typeof JSGroup>;
export const JSCalendar = z.union([JSEvent, JSGroup]);
