/**
 * The event form's values and their JSCalendar meaning (docs/architecture.md §17). The form keeps
 * what the user typed, as strings; `eventForm` reads a loaded event into it, `eventFields` turns it
 * into top-level JSCalendar fields, and all time arithmetic is Temporal.
 */
import { Temporal } from '@js-temporal/polyfill';
import type { components } from '@supercal/api-client';

export type JSEvent = components['schemas']['JSEvent'];
type Rule = NonNullable<JSEvent['recurrenceRule']>;
type Alert = NonNullable<JSEvent['alerts']>[string];
type Locations = NonNullable<JSEvent['locations']>;

export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
type Frequency = (typeof FREQUENCIES)[number];

/** `custom` is a rule from a calendar app that this form shows but cannot edit. */
export type Repeat = { frequency: 'none' | Frequency | 'custom'; interval: string; weekdays: Weekday[]; end: 'never' | 'on' | 'after'; until: string; count: string };
/** A reminder this form can edit; `id` is its key in `alerts`, empty until saved. */
export type Reminder = { id: string; offset: string };

export type EventForm = {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** Inclusive when all-day. */
  endDate: string;
  endTime: string;
  /** The event's zone; empty for a floating event. */
  zone: string;
  /** The zone the end is shown and typed in, when the event has an `endTimeZone`. */
  endZone: string | null;
  location: string;
  description: string;
  repeat: Repeat;
  status: string;
  freeBusyStatus: string;
  privacy: string;
  reminders: Reminder[];
};

export const REMINDER_OFFSETS = [
  { offset: 'PT0S', label: 'At the start' },
  { offset: '-PT5M', label: '5 minutes before' },
  { offset: '-PT10M', label: '10 minutes before' },
  { offset: '-PT15M', label: '15 minutes before' },
  { offset: '-PT30M', label: '30 minutes before' },
  { offset: '-PT1H', label: '1 hour before' },
  { offset: '-P1D', label: '1 day before' },
] as const;

const weekdayOf = (date: Temporal.PlainDate): Weekday => WEEKDAYS[date.dayOfWeek - 1] ?? 'mo';
const clock = (time: Temporal.PlainDateTime) => time.toPlainTime().toString({ smallestUnit: 'minute' });
const inZone = (local: Temporal.PlainDateTime, zone: string) => local.toZonedDateTime(zone || 'UTC');

/** A rule with anything beyond what the form offers came from a calendar app, and only that app can edit it. */
export function isCustomRule(rule: Rule): boolean {
  const simpleKeys = new Set(['@type', 'frequency', 'interval', 'count', 'until', 'byDay']);
  const simpleDay = (day: object) => Object.keys(day).every((key) => key === '@type' || key === 'day');
  return (
    !FREQUENCIES.some((frequency) => frequency === rule.frequency) ||
    Object.keys(rule).some((key) => !simpleKeys.has(key)) ||
    (rule.byDay !== undefined && (rule.frequency !== 'weekly' || !rule.byDay.every(simpleDay)))
  );
}

function repeatOf(rule: Rule | undefined, start: Temporal.PlainDate): Repeat {
  const none: Repeat = { frequency: 'none', interval: '1', weekdays: [weekdayOf(start)], end: 'never', until: '', count: '10' };
  if (!rule) return none;
  if (isCustomRule(rule)) return { ...none, frequency: 'custom' };
  const frequency = FREQUENCIES.find((f) => f === rule.frequency) ?? 'daily';
  return {
    frequency,
    interval: String(rule.interval ?? 1),
    weekdays: rule.byDay?.length ? WEEKDAYS.filter((day) => rule.byDay?.some((d) => d.day === day)) : none.weekdays,
    end: rule.until ? 'on' : rule.count ? 'after' : 'never',
    until: rule.until?.slice(0, 10) ?? '',
    count: String(rule.count ?? 10),
  };
}

const isEditableReminder = (alert: Alert) => alert.trigger['@type'] === 'OffsetTrigger' && alert.trigger.relativeTo !== 'end' && (alert.action ?? 'display') === 'display';

/** The location the form edits: the main one, or the first. */
const mainLocationIdOf = (event: JSEvent | undefined) => event?.mainLocationId ?? Object.keys(event?.locations ?? {})[0];

/** A loaded event as form values. `fallbackZone` is what an all-day event gets if the user adds times. */
export function eventForm(event: JSEvent, fallbackZone: string): EventForm {
  const allDay = event.showWithoutTime === true;
  const start = Temporal.PlainDateTime.from(event.start);
  const zone = event.timeZone ?? (allDay ? fallbackZone : '');
  const endZone = event.endTimeZone ?? null;
  const duration = Temporal.Duration.from(event.duration ?? (allDay ? 'P1D' : 'PT0S'));
  const end = allDay ? null : inZone(start, zone).add(duration).withTimeZone(endZone ?? (zone || 'UTC')).toPlainDateTime();
  const lastDay = start.toPlainDate().add(duration).subtract({ days: 1 });
  const mainId = mainLocationIdOf(event);
  return {
    title: event.title ?? '',
    allDay,
    startDate: start.toPlainDate().toString(),
    startTime: allDay ? '09:00' : clock(start),
    endDate: end ? end.toPlainDate().toString() : (Temporal.PlainDate.compare(lastDay, start) < 0 ? start.toPlainDate() : lastDay).toString(),
    endTime: end ? clock(end) : '10:00',
    zone,
    endZone,
    location: (mainId && event.locations?.[mainId]?.name) || '',
    description: event.description ?? '',
    repeat: repeatOf(event.recurrenceRule, start.toPlainDate()),
    status: event.status ?? 'confirmed',
    freeBusyStatus: event.freeBusyStatus ?? 'busy',
    privacy: event.privacy ?? 'public',
    reminders: Object.entries(event.alerts ?? {}).flatMap(([id, alert]) => (isEditableReminder(alert) && alert.trigger['@type'] === 'OffsetTrigger' ? [{ id, offset: alert.trigger.offset }] : [])),
  };
}

/**
 * A new event: the next full hour, one hour long, on today if `days` shows it and otherwise on the
 * first of `days`.
 */
export function newEventForm(days: readonly Temporal.PlainDate[], zone: string, now = Temporal.Now.zonedDateTimeISO(zone)): EventForm {
  const nextHour = now.round({ smallestUnit: 'hour', roundingMode: 'floor' }).add({ hours: 1 }).toPlainDateTime();
  const first = days[0];
  const start = first && !days.some((day) => day.equals(now.toPlainDate())) ? first.toPlainDateTime(nextHour.toPlainTime()) : nextHour;
  const end = start.add({ hours: 1 });
  return {
    title: '',
    allDay: false,
    startDate: start.toPlainDate().toString(),
    startTime: clock(start),
    endDate: end.toPlainDate().toString(),
    endTime: clock(end),
    zone,
    endZone: null,
    location: '',
    description: '',
    repeat: repeatOf(undefined, start.toPlainDate()),
    status: 'confirmed',
    freeBusyStatus: 'busy',
    privacy: 'public',
    reminders: [],
  };
}

const localOf = (date: string, time: string) => {
  try {
    return Temporal.PlainDateTime.from(`${date}T${time}`);
  } catch {
    return null;
  }
};

/** The new start, with the end moved by as much and a weekly rule's lone weekday following along. */
export function moveStart(form: EventForm, change: Partial<Pick<EventForm, 'startDate' | 'startTime'>>): EventForm {
  const next = { ...form, ...change };
  const from = localOf(form.startDate, form.startTime);
  const to = localOf(next.startDate, next.startTime);
  const end = localOf(form.endDate, form.endTime);
  if (!from || !to || !end) return next;
  const moved = end.add(from.until(to));
  const [only, ...others] = form.repeat.weekdays;
  const followsStart = only === weekdayOf(from.toPlainDate()) && others.length === 0;
  return { ...next, endDate: moved.toPlainDate().toString(), endTime: clock(moved), repeat: followsStart ? { ...form.repeat, weekdays: [weekdayOf(to.toPlainDate())] } : form.repeat };
}

const isCount = (value: string) => /^[1-9]\d*$/.test(value);

export type FormErrors = Partial<Record<'start' | 'end' | 'interval' | 'weekdays' | 'until' | 'count', string>>;

/** What must be fixed before the form means anything; the server still validates what is sent. */
export function formErrors(form: EventForm): FormErrors {
  const errors: FormErrors = {};
  const start = localOf(form.startDate, form.allDay ? '00:00' : form.startTime);
  const end = localOf(form.endDate, form.allDay ? '00:00' : form.endTime);
  if (!start) errors.start = 'Enter a start';
  if (!end) errors.end = 'Enter an end';
  if (start && end && inZone(end, form.endZone ?? form.zone).epochMilliseconds < inZone(start, form.zone).epochMilliseconds) errors.end = 'The end cannot be before the start';
  const { repeat } = form;
  if (repeat.frequency === 'none' || repeat.frequency === 'custom') return errors;
  if (!isCount(repeat.interval)) errors.interval = 'Enter a whole number';
  if (repeat.frequency === 'weekly' && repeat.weekdays.length === 0) errors.weekdays = 'Choose at least one day';
  if (repeat.end === 'after' && !isCount(repeat.count)) errors.count = 'Enter a whole number';
  if (repeat.end === 'on') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(repeat.until)) errors.until = 'Enter a date';
    else if (start && Temporal.PlainDate.compare(repeat.until, start.toPlainDate()) < 0) errors.until = 'Choose a date after the start';
  }
  return errors;
}

/**
 * The length from the wall-clock start to the wall-clock end the user chose. Counted in hours, which
 * are exact, so the end stays where it was typed across a DST change, and the schema takes it
 * (it refuses years and months).
 */
export const timedDuration = (start: Temporal.PlainDateTime, end: Temporal.PlainDateTime, zone: string, endZone = zone) =>
  inZone(start, zone).until(inZone(end, endZone), { largestUnit: 'hours' }).toString();

/** `P<n>D` for an all-day event whose end date is included. */
export const allDayDuration = (startDate: string, endDate: string) => `P${Temporal.PlainDate.from(startDate).until(endDate).days + 1}D`;

/** The form's rule. `until` is local to the event's zone: the event's own start time on the date, the last moment that includes that day's occurrence. */
export function ruleOf({ repeat, allDay, startTime }: Pick<EventForm, 'repeat' | 'allDay' | 'startTime'>): Rule | undefined {
  if (repeat.frequency === 'none' || repeat.frequency === 'custom') return undefined;
  const interval = Number(repeat.interval);
  return {
    frequency: repeat.frequency,
    ...(interval > 1 && { interval }),
    ...(repeat.frequency === 'weekly' && { byDay: WEEKDAYS.filter((day) => repeat.weekdays.includes(day)).map((day) => ({ day })) }),
    ...(repeat.end === 'on' && { until: `${repeat.until}T${allDay ? '00:00' : startTime}:00` }),
    ...(repeat.end === 'after' && { count: Number(repeat.count) }),
  };
}

function locationFields(name: string, before: JSEvent | undefined): Pick<JSEvent, 'locations' | 'mainLocationId'> {
  const mainId = mainLocationIdOf(before);
  const main = mainId === undefined ? undefined : before?.locations?.[mainId];
  const kept = before?.mainLocationId === undefined ? {} : { mainLocationId: before.mainLocationId };
  if (mainId === undefined || !main) return name ? { locations: { main: { name } }, mainLocationId: 'main' } : {};
  const others: Locations = Object.fromEntries(Object.entries(before?.locations ?? {}).filter(([id]) => id !== mainId));
  if (name) return { locations: { ...others, [mainId]: { ...main, name } }, ...kept };
  return Object.keys(others).length ? { locations: others } : {};
}

function alertFields(reminders: readonly Reminder[], before: JSEvent | undefined): Pick<JSEvent, 'alerts'> {
  const existing = before?.alerts ?? {};
  const alerts: NonNullable<JSEvent['alerts']> = Object.fromEntries(Object.entries(existing).filter(([, alert]) => !isEditableReminder(alert)));
  let next = 1;
  for (const { id, offset } of reminders) {
    const old = existing[id];
    if (old && id) {
      alerts[id] = { ...old, trigger: { ...old.trigger, '@type': 'OffsetTrigger', offset } };
      continue;
    }
    while (`a${next}` in existing || `a${next}` in alerts) next++;
    alerts[`a${next}`] = { trigger: { '@type': 'OffsetTrigger', offset }, action: 'display' };
  }
  return Object.keys(alerts).length ? { alerts } : {};
}

function timingFields(form: EventForm): Pick<JSEvent, 'start' | 'duration' | 'timeZone' | 'endTimeZone' | 'showWithoutTime'> {
  if (form.allDay) return { start: `${form.startDate}T00:00:00`, duration: allDayDuration(form.startDate, form.endDate), showWithoutTime: true };
  const start = Temporal.PlainDateTime.from(`${form.startDate}T${form.startTime}`);
  const end = Temporal.PlainDateTime.from(`${form.endDate}T${form.endTime}`);
  return {
    start: start.toString({ smallestUnit: 'second' }),
    duration: timedDuration(start, end, form.zone, form.endZone ?? form.zone),
    ...(form.zone && { timeZone: form.zone }),
    ...(form.endZone && { endTimeZone: form.endZone }),
  };
}

/**
 * The top-level JSCalendar fields the form controls; an absent key means "not set". `before` supplies
 * what the form edits only part of: other locations, the main location's other details, and alerts
 * it cannot show.
 */
export function eventFields(form: EventForm, before?: JSEvent) {
  const title = form.title.trim();
  const rule = ruleOf(form);
  return {
    ...timingFields(form),
    ...locationFields(form.location.trim(), before),
    ...alertFields(form.reminders, before),
    ...(title && { title }),
    ...(form.description && { description: form.description }),
    ...(rule && { recurrenceRule: rule }),
    status: form.status,
    freeBusyStatus: form.freeBusyStatus,
    privacy: form.privacy,
  } satisfies Partial<JSEvent>;
}

/** The body that creates this form's event. The server assigns the UID and its own fields. */
export const newEventBody = (form: EventForm): JSEvent => ({ '@type': 'Event', version: '2.0', ...eventFields(form) });

const DAY_NAMES: Record<Weekday, string> = { mo: 'Mon', tu: 'Tue', we: 'Wed', th: 'Thu', fr: 'Fri', sa: 'Sat', su: 'Sun' };
const UNITS: Record<Frequency, string> = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
export const unitOf = (frequency: Frequency) => UNITS[frequency];
export const dayName = (day: Weekday) => DAY_NAMES[day];

export const CUSTOM_REPEAT = 'Custom repeat, set in another app';

/** A rule in words, for the event's details. */
export function repeatSummary(rule: Rule): string {
  if (isCustomRule(rule)) return CUSTOM_REPEAT;
  const unit = FREQUENCIES.find((f) => f === rule.frequency);
  if (!unit) return CUSTOM_REPEAT;
  const every = (rule.interval ?? 1) > 1 ? `Every ${rule.interval} ${UNITS[unit]}s` : `Every ${UNITS[unit]}`;
  const days = rule.byDay?.length ? ` on ${WEEKDAYS.filter((day) => rule.byDay?.some((d) => d.day === day)).map(dayName).join(', ')}` : '';
  const end = rule.until ? `, until ${rule.until.slice(0, 10)}` : rule.count ? `, ${rule.count} times` : '';
  return `${every}${days}${end}`;
}
