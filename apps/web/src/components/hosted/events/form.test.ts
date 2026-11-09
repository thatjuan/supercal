import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, test } from 'vitest';
import { weekOf } from '../../preview/layout.ts';
import { allDayDuration, eventFields, eventForm, formErrors, isCustomRule, moveStart, newEventBody, newEventForm, ruleOf, timedDuration, type EventForm, type JSEvent } from './form.ts';

const NY = 'America/New_York';
const local = (value: string) => Temporal.PlainDateTime.from(value);
const event = (fields: Partial<JSEvent> = {}): JSEvent => ({ '@type': 'Event', version: '2.0', start: '2026-11-16T09:00:00', duration: 'PT1H', timeZone: NY, ...fields });
const form = (fields: Partial<JSEvent> = {}, change: Partial<EventForm> = {}) => ({ ...eventForm(event(fields), NY), ...change });

describe('duration', () => {
  test('keeps the wall-clock end across a DST change', () => {
    // 01:00 to 04:00 on the night New York springs forward is two hours, and reads back as 04:00.
    const duration = timedDuration(local('2026-03-08T01:00'), local('2026-03-08T04:00'), NY);
    expect(duration).toBe('PT2H');
    const back = eventForm(event({ start: '2026-03-08T01:00:00', duration }), NY);
    expect([back.endDate, back.endTime]).toEqual(['2026-03-08', '04:00']);
  });

  test('is in hours, which the schema takes, for a multi-day event', () => {
    expect(timedDuration(local('2026-11-16T09:00'), local('2026-11-18T10:30'), NY)).toBe('PT49H30M');
  });

  test('an all-day end date is inclusive', () => {
    expect(allDayDuration('2026-11-16', '2026-11-16')).toBe('P1D');
    expect(allDayDuration('2026-11-16', '2026-11-18')).toBe('P3D');
    const back = eventForm(event({ start: '2026-11-16T00:00:00', duration: 'P3D', showWithoutTime: true }), NY);
    expect(back.endDate).toBe('2026-11-18');
  });

  test('an end in its own zone is shown there, and the zone is kept', () => {
    const flight = form({ start: '2026-11-16T09:00:00', duration: 'PT8H', endTimeZone: 'Europe/London' });
    expect([flight.endTime, flight.endZone]).toEqual(['22:00', 'Europe/London']);
    expect(eventFields(flight)).toMatchObject({ duration: 'PT8H', endTimeZone: 'Europe/London', timeZone: NY });
  });
});

describe('all-day fields', () => {
  test('have no zone', () => {
    const fields = eventFields(form({}, { allDay: true, endDate: '2026-11-17' }));
    expect(fields).toMatchObject({ start: '2026-11-16T00:00:00', duration: 'P2D', showWithoutTime: true });
    expect(fields).not.toHaveProperty('timeZone');
  });
});

describe('the rule', () => {
  const repeat = (change: Partial<EventForm['repeat']>): EventForm['repeat'] => ({ frequency: 'weekly', interval: '2', weekdays: ['we', 'mo'], end: 'never', until: '', count: '10', ...change });

  test('matches the JSCalendar shape, with weekdays in order', () => {
    expect(ruleOf({ repeat: repeat({ end: 'on', until: '2027-01-14' }), allDay: false, startTime: '09:00' })).toEqual({ frequency: 'weekly', interval: 2, byDay: [{ day: 'mo' }, { day: 'we' }], until: '2027-01-14T09:00:00' });
  });

  test('until is the event’s own local start time on the date, or midnight when all-day', () => {
    expect(ruleOf({ repeat: repeat({ frequency: 'daily', interval: '1', end: 'on', until: '2027-01-14' }), allDay: false, startTime: '17:30' })).toEqual({ frequency: 'daily', until: '2027-01-14T17:30:00' });
    expect(ruleOf({ repeat: repeat({ frequency: 'daily', interval: '1', end: 'on', until: '2027-01-14' }), allDay: true, startTime: '17:30' })).toEqual({ frequency: 'daily', until: '2027-01-14T00:00:00' });
  });

  test('count clears until', () => {
    const before = form({ recurrenceRule: { frequency: 'daily', until: '2027-01-14T09:00:00' } });
    expect(eventFields({ ...before, repeat: { ...before.repeat, end: 'after', count: '5' } }).recurrenceRule).toEqual({ frequency: 'daily', count: 5 });
  });

  test('anything the form does not offer is custom', () => {
    expect(isCustomRule({ frequency: 'weekly', interval: 2, byDay: [{ day: 'mo' }], until: '2027-01-14T09:00:00' })).toBe(false);
    expect(isCustomRule({ frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 1 }] })).toBe(true);
    expect(isCustomRule({ frequency: 'monthly', bySetPosition: [1] })).toBe(true);
    expect(isCustomRule({ frequency: 'daily', byHour: [9] })).toBe(true);
    expect(isCustomRule({ frequency: 'yearly', rscale: 'hebrew' })).toBe(true);
    expect(isCustomRule({ frequency: 'hourly' })).toBe(true);
  });
});

describe('a new event', () => {
  const zone = 'Europe/Berlin';
  const now = Temporal.ZonedDateTime.from('2026-11-18T14:20:00+01:00[Europe/Berlin]');

  test('starts at the next full hour, for one hour, today when it is visible', () => {
    const fresh = newEventForm(weekOf(now.toPlainDate()), zone, now);
    expect([fresh.startDate, fresh.startTime, fresh.endDate, fresh.endTime, fresh.zone]).toEqual(['2026-11-18', '15:00', '2026-11-18', '16:00', zone]);
  });

  test('starts on the first visible day when today is not', () => {
    const fresh = newEventForm(weekOf(Temporal.PlainDate.from('2026-12-02')), zone, now);
    expect([fresh.startDate, fresh.startTime]).toEqual(['2026-11-30', '15:00']);
  });

  test('its body is an Event with none of what the server sets', () => {
    const body = newEventBody({ ...newEventForm(weekOf(now.toPlainDate()), zone, now), title: 'Launch', location: 'Hall', reminders: [{ id: '', offset: '-PT10M' }] });
    expect(body).toEqual({
      '@type': 'Event',
      version: '2.0',
      title: 'Launch',
      start: '2026-11-18T15:00:00',
      duration: 'PT1H',
      timeZone: zone,
      locations: { main: { name: 'Hall' } },
      mainLocationId: 'main',
      alerts: { a1: { trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' }, action: 'display' } },
      status: 'confirmed',
      freeBusyStatus: 'busy',
      privacy: 'public',
    });
  });
});

test('moving the start moves the end by as much, and a lone weekday with it', () => {
  const before = form({ recurrenceRule: { frequency: 'weekly' } });
  const moved = moveStart(before, { startDate: '2026-11-17' });
  expect([moved.endDate, moved.endTime]).toEqual(['2026-11-17', '10:00']);
  expect(moved.repeat.weekdays).toEqual(['tu']);
});

test('formErrors finds what the form cannot mean', () => {
  expect(formErrors(form())).toEqual({});
  expect(formErrors(form({}, { startDate: '' })).start).toBeDefined();
  expect(formErrors(form({}, { endTime: '08:00' })).end).toBeDefined();
  const weekly = form({ recurrenceRule: { frequency: 'weekly' } });
  expect(formErrors({ ...weekly, repeat: { ...weekly.repeat, weekdays: [] } }).weekdays).toBeDefined();
  expect(formErrors({ ...weekly, repeat: { ...weekly.repeat, interval: '0' } }).interval).toBeDefined();
  expect(formErrors({ ...weekly, repeat: { ...weekly.repeat, end: 'on', until: '2026-11-01' } }).until).toBeDefined();
});
