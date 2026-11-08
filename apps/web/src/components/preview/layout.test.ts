import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, test } from 'vitest';
import { layoutWeek, weekOf, windowOf, type Occurrence } from './layout.ts';

const zone = 'Europe/Berlin';
const days = weekOf(Temporal.PlainDate.from('2026-11-04'));

/** An occurrence from Berlin wall-clock times. */
const event = (summary: string, start: string, end: string, allDay = false): Occurrence => ({
  publicationId: 'pub_1',
  outputUid: summary,
  recurrenceId: '',
  start: Temporal.PlainDateTime.from(start).toZonedDateTime(allDay ? 'UTC' : zone).toInstant().toString(),
  end: Temporal.PlainDateTime.from(end).toZonedDateTime(allDay ? 'UTC' : zone).toInstant().toString(),
  allDay,
  summary,
  color: null,
});

const place = (occurrences: Occurrence[]) => layoutWeek(occurrences, days, zone);
const columnsOf = (layout: ReturnType<typeof place>) => Object.fromEntries(layout.timed.map((b) => [b.occurrence.summary, [b.column, b.columns]]));

describe('preview layout', () => {
  test('the week runs Monday to Sunday, and its window is midnight to midnight in the zone', () => {
    expect(days.map(String)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(windowOf(days, zone)).toEqual({ from: '2026-11-01T23:00:00Z', to: '2026-11-08T23:00:00Z' });
  });

  test('overlapping events share the day side by side; a later separate event gets the full width', () => {
    const layout = place([
      event('Standup', '2026-11-04T09:00', '2026-11-04T10:00'),
      event('Review', '2026-11-04T09:30', '2026-11-04T11:00'),
      event('Coffee', '2026-11-04T10:00', '2026-11-04T10:30'),
      event('Lunch', '2026-11-04T12:00', '2026-11-04T13:00'),
    ]);
    // Coffee reuses Standup's column once Standup ends; all three overlap through Review.
    expect(columnsOf(layout)).toEqual({ Standup: [0, 2], Review: [1, 2], Coffee: [0, 2], Lunch: [0, 1] });
    const standup = layout.timed.find((b) => b.occurrence.summary === 'Standup');
    expect(standup).toMatchObject({ day: 2, startMinute: 9 * 60, endMinute: 10 * 60 });
  });

  test('an event past midnight is cut into a piece on each day', () => {
    const layout = place([event('Night shift', '2026-11-04T22:00', '2026-11-05T02:00')]);
    expect(layout.timed.map(({ day, startMinute, endMinute }) => [day, startMinute, endMinute])).toEqual([
      [2, 22 * 60, 24 * 60],
      [3, 0, 2 * 60],
    ]);
  });

  test('all-day events go to the top lane, spanning their days and stacking into rows', () => {
    const layout = place([
      event('Conference', '2026-11-03T00:00', '2026-11-06T00:00', true),
      event('Holiday', '2026-11-04T00:00', '2026-11-05T00:00', true),
      event('Standup', '2026-11-04T09:00', '2026-11-04T10:00'),
    ]);
    expect(layout.allDay.map(({ occurrence, firstDay, lastDay, row }) => [occurrence.summary, firstDay, lastDay, row])).toEqual([
      ['Conference', 1, 3, 0],
      ['Holiday', 2, 2, 1],
    ]);
    expect(layout.allDayRows).toBe(2);
    expect(layout.timed.map((b) => b.occurrence.summary)).toEqual(['Standup']);
  });
});
