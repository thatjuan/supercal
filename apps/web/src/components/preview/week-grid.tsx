/** The preview's week view: an all-day lane on top, then 24 hour rows with timed events side by side. */
import { Temporal } from '@js-temporal/polyfill';
import { useEffect, useRef } from 'react';
import { EventBlock } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { clockTime, layoutWeek, type Occurrence } from './layout.ts';

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const SCROLL_TO_HOUR = 7;

type Props = { days: Temporal.PlainDate[]; occurrences: Occurrence[]; zone: string; colorOf: (o: Occurrence) => string };

const dayLabel = (day: Temporal.PlainDate) => day.toLocaleString('en', { weekday: 'short' });

export function WeekGrid({ days, occurrences, zone, colorOf }: Props) {
  const { timed, allDay, allDayRows } = layoutWeek(occurrences, days, zone);
  const today = Temporal.Now.plainDateISO(zone);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: SCROLL_TO_HOUR * HOUR_PX - 12 });
  }, []);

  const columns = 'grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]';
  return (
    <div ref={scroller} className="max-h-[min(72vh,44rem)] overflow-y-auto rounded-[14px] border border-line bg-surface shadow-xs" data-testid="week-grid">
      <div className="sticky top-0 z-10 bg-surface">
        <div className={cx(columns, 'border-b border-line')}>
          <div />
          {days.map((day) => (
            <div key={day.toString()} className="border-l border-line px-2 py-2 text-center">
              <span className="block text-[12px] tracking-wide text-ink-3 uppercase">{dayLabel(day)}</span>
              <span
                className={cx(
                  'mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-[15px] font-semibold',
                  day.equals(today) && 'bg-accent text-accent-ink',
                )}
              >
                {day.day}
              </span>
            </div>
          ))}
        </div>

        <div className={cx(columns, 'border-b border-line')} data-testid="all-day-lane">
          <div className="px-1.5 py-1.5 text-right text-[11px] text-ink-3">all-day</div>
          <div
            className="col-span-7 grid grid-cols-7 gap-y-1 border-l border-line py-1"
            style={{ minHeight: '1.75rem', gridTemplateRows: `repeat(${Math.max(1, allDayRows)}, auto)` }}
          >
            {allDay.map(({ occurrence, firstDay, lastDay, row }) => (
              <div
                key={`${occurrence.publicationId}/${occurrence.outputUid}/${occurrence.recurrenceId}`}
                className="px-0.5"
                style={{ gridColumn: `${firstDay + 1} / ${lastDay + 2}`, gridRow: row + 1 }}
              >
                <EventBlock color={colorOf(occurrence)} title={occurrence.summary} className="py-0.5" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={cx(columns, 'relative')} style={{ height: HOUR_PX * 24 }}>
        <div>
          {HOURS.map((hour) => (
            <div key={hour} className="relative text-right text-[11px] text-ink-3" style={{ height: HOUR_PX }}>
              {hour > 0 && <span className="absolute -top-2 right-2">{String(hour).padStart(2, '0')}:00</span>}
            </div>
          ))}
        </div>
        {days.map((day, index) => (
          <div key={day.toString()} className="relative border-l border-line" data-testid={`day-${index}`}>
            {HOURS.map((hour) => (
              <div key={hour} className="border-t border-line/70 first:border-t-0" style={{ height: HOUR_PX }} />
            ))}
            {timed
              .filter((block) => block.day === index)
              .map(({ occurrence, startMinute, endMinute, column, columns: count }) => (
                <div
                  key={`${occurrence.publicationId}/${occurrence.outputUid}/${occurrence.recurrenceId}`}
                  data-testid="timed-event"
                  title={`${occurrence.summary}\n${clockTime(occurrence.start, zone)}–${clockTime(occurrence.end, zone)}${occurrence.location ? `\n${occurrence.location}` : ''}`}
                  className="absolute px-px"
                  style={{
                    top: (startMinute / 60) * HOUR_PX,
                    height: Math.max(18, ((endMinute - startMinute) / 60) * HOUR_PX),
                    left: `${(column / count) * 100}%`,
                    width: `${100 / count}%`,
                  }}
                >
                  <EventBlock
                    color={colorOf(occurrence)}
                    title={occurrence.summary}
                    meta={endMinute - startMinute >= 45 ? [clockTime(occurrence.start, zone), occurrence.location].filter(Boolean).join(' · ') : undefined}
                    className="h-full overflow-hidden"
                  />
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
