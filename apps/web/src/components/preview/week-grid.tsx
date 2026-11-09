/**
 * The week view of Preview and of a hosted calendar's Events tab: an all-day lane on top, then 24
 * hour rows with timed events side by side. With `onSelect`, each block is a button.
 */
import { Temporal } from '@js-temporal/polyfill';
import { useEffect, useRef, type ReactNode } from 'react';
import { EventBlock } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { clockTime, layoutWeek, type GridItem } from './layout.ts';

const HOUR_PX = 44;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const SCROLL_TO_HOUR = 7;

type Props<T extends GridItem> = { days: Temporal.PlainDate[]; items: T[]; zone: string; colorOf: (item: T) => string; onSelect?: ((item: T) => void) | undefined };

const dayLabel = (day: Temporal.PlainDate) => day.toLocaleString('en', { weekday: 'short' });

/** A struck-through title for a cancelled event. */
const titleOf = (item: GridItem): ReactNode => (item.cancelled ? <span className="line-through">{item.title}</span> : item.title);

/** `block` as a keyboard-reachable button when the view is selectable. */
const selectable = (block: ReactNode, select: (() => void) | undefined) =>
  select ? (
    <button type="button" onClick={select} className="block size-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-accent">
      {block}
    </button>
  ) : (
    block
  );

export function WeekGrid<T extends GridItem>({ days, items, zone, colorOf, onSelect }: Props<T>) {
  const { timed, allDay, allDayRows } = layoutWeek(items, days, zone);
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
                key={occurrence.key}
                className="px-0.5"
                style={{ gridColumn: `${firstDay + 1} / ${lastDay + 2}`, gridRow: row + 1 }}
              >
                {selectable(<EventBlock color={colorOf(occurrence)} title={titleOf(occurrence)} className="py-0.5" />, onSelect && (() => onSelect(occurrence)))}
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
                  key={occurrence.key}
                  data-testid="timed-event"
                  title={`${occurrence.title}\n${clockTime(occurrence.start, zone)}–${clockTime(occurrence.end, zone)}${occurrence.location ? `\n${occurrence.location}` : ''}`}
                  className="absolute px-px"
                  style={{
                    top: (startMinute / 60) * HOUR_PX,
                    height: Math.max(18, ((endMinute - startMinute) / 60) * HOUR_PX),
                    left: `${(column / count) * 100}%`,
                    width: `${100 / count}%`,
                  }}
                >
                  {selectable(
                    <EventBlock
                      color={colorOf(occurrence)}
                      title={titleOf(occurrence)}
                      meta={endMinute - startMinute >= 45 ? [clockTime(occurrence.start, zone), occurrence.location].filter(Boolean).join(' · ') : undefined}
                      className="h-full overflow-hidden"
                    />,
                    onSelect && (() => onSelect(occurrence)),
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
