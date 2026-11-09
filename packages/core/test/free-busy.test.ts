import { describe, expect, test } from 'bun:test';
import { Temporal } from '@js-temporal/polyfill';
import { freeBusy, freeBusyWindowProblem, parseCalendar, MAX_ITERATIONS, type EventResource } from '../src/index.ts';

const instant = Temporal.Instant.from;
function events(...components: string[][]): EventResource[] {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...components.flatMap((lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
  const parsed = parseCalendar(text);
  expect(parsed.errors).toEqual([]);
  return parsed.resources;
}
function query(resources: EventResource[], from: string, to: string, zone = 'UTC') {
  const result = freeBusy(resources, { from: instant(from), to: instant(to) }, zone);
  return { intervals: result.intervals.map(({ start, end, status }) => [start.toString(), end.toString(), status]), truncated: result.truncated };
}
describe('freeBusy', () => {
  test('skips one unreadable resource while reporting its two neighbours', () => {
    const data = events(['UID:first', 'DTSTART:20261109T090000Z', 'DURATION:PT1H'],
      ['UID:bad', 'DTSTART:20261109T110000Z', 'RRULE:FREQ=DAILY', 'EXDATE;TZID=Unknown/Zone:20261110T110000'],
      ['UID:last', 'DTSTART:20261109T130000Z', 'DURATION:PT1H']);
    const result = freeBusy(data, { from: instant('2026-11-09T00:00:00Z'), to: instant('2026-11-10T00:00:00Z') }, 'UTC');
    expect(result.skipped).toEqual(['bad']);
    expect(result.truncated).toBe(false);
    expect(result.intervals.map((i) => [i.start.toString(), i.end.toString()])).toEqual([
      ['2026-11-09T09:00:00Z', '2026-11-09T10:00:00Z'], ['2026-11-09T13:00:00Z', '2026-11-09T14:00:00Z'],
    ]);
  });

  test('recurrence uses EXDATE and a moved override', () => {
    const data = events(['UID:series', 'DTSTART:20261109T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20261110T090000Z'],
      ['UID:series', 'RECURRENCE-ID:20261111T090000Z', 'DTSTART:20261111T110000Z', 'DURATION:PT2H', 'STATUS:TENTATIVE']);
    expect(query(data, '2026-11-09T00:00:00Z', '2026-11-13T00:00:00Z')).toEqual({ truncated: false, intervals: [
      ['2026-11-09T09:00:00Z', '2026-11-09T10:00:00Z', 'busy'], ['2026-11-11T11:00:00Z', '2026-11-11T13:00:00Z', 'tentative'], ['2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z', 'busy'],
    ] });
  });
  test('wall time stays constant across DST', () => {
    const data = events(['UID:dst', 'DTSTART;TZID=America/New_York:20261031T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=3']);
    expect(query(data, '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z').intervals).toEqual([
      ['2026-10-31T13:00:00Z', '2026-10-31T14:00:00Z', 'busy'], ['2026-11-01T14:00:00Z', '2026-11-01T15:00:00Z', 'busy'], ['2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z', 'busy'],
    ]);
  });
  test('cancelled and transparent components are excluded, private time counts', () => {
    const data = events(...['STATUS:CANCELLED', 'TRANSP:TRANSPARENT', 'CLASS:PRIVATE'].map((flag, i) => [`UID:event-${i}`, 'DTSTART:20261109T090000Z', 'DURATION:PT1H', flag]));
    expect(query(data, '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z').intervals).toEqual([['2026-11-09T09:00:00Z', '2026-11-09T10:00:00Z', 'busy']]);
  });
  test('merges each status, busy wins overlaps, clips both edges', () => {
    const data = events(['UID:tentative', 'DTSTART:20261109T080000Z', 'DURATION:PT5H', 'STATUS:TENTATIVE'],
      ['UID:busy', 'DTSTART:20261109T100000Z', 'DURATION:PT1H'], ['UID:busy2', 'DTSTART:20261109T103000Z', 'DURATION:PT1H']);
    expect(query(data, '2026-11-09T09:00:00Z', '2026-11-09T12:00:00Z').intervals).toEqual([
      ['2026-11-09T09:00:00Z', '2026-11-09T10:00:00Z', 'tentative'], ['2026-11-09T10:00:00Z', '2026-11-09T11:30:00Z', 'busy'], ['2026-11-09T11:30:00Z', '2026-11-09T12:00:00Z', 'tentative'],
    ]);
  });
  test('floating and all-day events use the calendar zone', () => {
    const data = events(['UID:floating', 'DTSTART:20261109T090000', 'DURATION:PT1H'], ['UID:day', 'DTSTART;VALUE=DATE:20261110', 'DTEND;VALUE=DATE:20261111']);
    expect(query(data, '2026-11-09T00:00:00Z', '2026-11-12T00:00:00Z', 'America/New_York').intervals).toEqual([
      ['2026-11-09T14:00:00Z', '2026-11-09T15:00:00Z', 'busy'], ['2026-11-10T05:00:00Z', '2026-11-11T05:00:00Z', 'busy'],
    ]);
  });
  test('expansion limits propagate as truncated', () => {
    const data = events(['UID:dense', 'DTSTART:20261109T000000Z', 'DURATION:PT1S', 'RRULE:FREQ=SECONDLY;COUNT=6000']);
    expect(query(data, '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z').truncated).toBe(true);
  });
});


describe('free-busy budgets', () => {
  test('refuses nonpositive, over-62-day and far-future windows', () => {
    const now = instant('2026-11-09T00:00:00Z');
    const problem = (from: string, to: string) => freeBusyWindowProblem({ from: instant(from), to: instant(to) }, now);
    expect(problem('2526-11-09T00:00:00Z', '2526-11-10T00:00:00Z')).toBe('Window must end within 5 years');
    expect(freeBusyWindowProblem({ from: now, to: now.add({ hours: 500 * 24 }) }, now)).toBe('Window must be at most 62 days');
    expect(freeBusyWindowProblem({ from: now, to: now }, now)).toBe('Window must be positive');
    expect(freeBusyWindowProblem({ from: now, to: now.add({ hours: 62 * 24 }) }, now)).toBeNull();
  });

  test('stops before inspecting a second resource when the first truncates', () => {
    const data = events(...['first', 'second'].map((uid) => [`UID:${uid}`, 'DTSTART:20260101T000000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30']));
    Object.defineProperty(data[1]!, 'master', { get() { throw new Error('second resource was expanded'); } });
    expect(query(data, '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z')).toEqual({ intervals: [], truncated: true });
  });

  test('shares the RRULE value budget across resources', () => {
    const count = MAX_ITERATIONS / 2 + 1;
    const data = events(...['first', 'second'].map((uid) => [`UID:${uid}`, 'DTSTART:19000101T000000Z', `RRULE:FREQ=DAILY;COUNT=${count}`]));
    expect(query(data, '2026-11-09T00:00:00Z', '2026-11-10T00:00:00Z')).toEqual({ intervals: [], truncated: true });
  });
});
