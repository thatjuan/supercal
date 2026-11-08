/**
 * Preview layout maths, all in Temporal: the week around a date, the API window for it, and where
 * each occurrence goes in the week grid. Timed events are cut at midnight in the chosen zone and
 * placed side by side when they overlap; all-day events go in the top lane, stacked into rows.
 */
import { Temporal } from '@js-temporal/polyfill';
import type { components } from '@supercal/api-client';

export type Occurrence = components['schemas']['Occurrence'];

const MINUTES_PER_DAY = 24 * 60;

/** The Monday-to-Sunday week containing `date`. */
export function weekOf(date: Temporal.PlainDate): Temporal.PlainDate[] {
  const monday = date.subtract({ days: date.dayOfWeek - 1 });
  return Array.from({ length: 7 }, (_, i) => monday.add({ days: i }));
}

/** `[from, to)` for the occurrences query: midnight before the first day to midnight after the last, in `zone`. */
export function windowOf(days: readonly Temporal.PlainDate[], zone: string): { from: string; to: string } {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) throw new Error('windowOf needs at least one day');
  return {
    from: first.toZonedDateTime(zone).toInstant().toString(),
    to: last.add({ days: 1 }).toZonedDateTime(zone).toInstant().toString(),
  };
}

/**
 * The dates an all-day occurrence covers, `end` exclusive. The API gives its start and end as the
 * instants of midnight in the source calendar's zone, which it does not name; rounding to the
 * nearest UTC midnight recovers the date for every zone within ±12 hours of UTC.
 */
export function allDayDates(occurrence: Pick<Occurrence, 'start' | 'end'>): { start: Temporal.PlainDate; end: Temporal.PlainDate } {
  const date = (iso: string) => Temporal.Instant.from(iso).add({ hours: 12 }).toZonedDateTimeISO('UTC').toPlainDate();
  const start = date(occurrence.start);
  const end = date(occurrence.end);
  return { start, end: Temporal.PlainDate.compare(end, start) > 0 ? end : start.add({ days: 1 }) };
}

/** A timed occurrence's piece on one day: minutes from midnight, and its column among overlapping pieces. */
export type TimedBlock = { occurrence: Occurrence; day: number; startMinute: number; endMinute: number; column: number; columns: number };
/** An all-day occurrence in the top lane: the day indexes it spans and its row. */
export type AllDayBlock = { occurrence: Occurrence; firstDay: number; lastDay: number; row: number };

/** Places `occurrences` on the grid of `days`, as seen in `zone`. */
export function layoutWeek(occurrences: readonly Occurrence[], days: readonly Temporal.PlainDate[], zone: string) {
  const timed: TimedBlock[] = [];
  days.forEach((day, index) => {
    const dayStart = day.toZonedDateTime(zone).toInstant();
    const dayEnd = day.add({ days: 1 }).toZonedDateTime(zone).toInstant();
    const pieces = occurrences
      .filter((o) => !o.allDay)
      .flatMap((occurrence) => {
        const start = Temporal.Instant.from(occurrence.start);
        const end = Temporal.Instant.from(occurrence.end);
        const touches = Temporal.Instant.compare(start, dayEnd) < 0 && (Temporal.Instant.compare(end, dayStart) > 0 || (start.equals(end) && Temporal.Instant.compare(start, dayStart) >= 0));
        if (!touches) return [];
        const minuteOf = (instant: Temporal.Instant) => {
          const local = instant.toZonedDateTimeISO(zone);
          return local.hour * 60 + local.minute;
        };
        const startMinute = Temporal.Instant.compare(start, dayStart) <= 0 ? 0 : minuteOf(start);
        const endMinute = Temporal.Instant.compare(end, dayEnd) >= 0 ? MINUTES_PER_DAY : minuteOf(end);
        return [{ occurrence, day: index, startMinute, endMinute: Math.max(endMinute, startMinute) }];
      });
    timed.push(...placeSideBySide(pieces));
  });

  const allDay: AllDayBlock[] = [];
  const rowEnds: number[] = [];
  const first = days[0];
  for (const occurrence of occurrences.filter((o) => o.allDay)) {
    if (!first) break;
    const { start, end } = allDayDates(occurrence);
    const firstDay = Math.max(0, first.until(start).days);
    const lastDay = Math.min(days.length - 1, first.until(end).days - 1);
    if (lastDay < firstDay) continue;
    let row = rowEnds.findIndex((rowEnd) => rowEnd < firstDay);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = lastDay;
    allDay.push({ occurrence, firstDay, lastDay, row });
  }
  return { timed, allDay, allDayRows: rowEnds.length };
}

type Piece = Omit<TimedBlock, 'column' | 'columns'>;

/** Gives each piece of one day a column: pieces that overlap, directly or through others, share a column count. */
function placeSideBySide(pieces: Piece[]): TimedBlock[] {
  const sorted = [...pieces].sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute);
  const placed: TimedBlock[] = [];
  let cluster: TimedBlock[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;

  const close = () => {
    for (const block of cluster) block.columns = columnEnds.length;
    placed.push(...cluster);
    cluster = [];
    columnEnds = [];
  };

  for (const piece of sorted) {
    // A zero-length piece still takes a little room, so it overlaps what starts right after it.
    const end = Math.max(piece.endMinute, piece.startMinute + 15);
    if (piece.startMinute >= clusterEnd) close();
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= piece.startMinute);
    if (column === -1) column = columnEnds.length;
    columnEnds[column] = end;
    clusterEnd = Math.max(clusterEnd, end);
    cluster.push({ ...piece, column, columns: 0 });
  }
  close();
  return placed;
}

/** The local date an occurrence is listed under in the agenda. */
export function agendaDate(occurrence: Occurrence, zone: string): Temporal.PlainDate {
  return occurrence.allDay ? allDayDates(occurrence).start : Temporal.Instant.from(occurrence.start).toZonedDateTimeISO(zone).toPlainDate();
}

/** "09:30" in `zone`. */
export const clockTime = (iso: string, zone: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(zone).toPlainTime().toString({ smallestUnit: 'minute' });
