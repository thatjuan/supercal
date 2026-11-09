/** The agenda view of Preview and of a hosted calendar's Events tab: the window's occurrences listed by local day. With `onSelect`, each row is a button. */
import type { Temporal } from '@js-temporal/polyfill';
import { ColorChip } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { agendaDate, clockTime, type GridItem } from './layout.ts';

type Props<T extends GridItem> = { days: Temporal.PlainDate[]; items: T[]; zone: string; colorOf: (item: T) => string; onSelect?: ((item: T) => void) | undefined; emptyText?: string };

const ROW = 'flex items-baseline gap-3 text-sm';

export function Agenda<T extends GridItem>({ days, items, zone, colorOf, onSelect, emptyText = 'Nothing published this week.' }: Props<T>) {
  const byDay = days.map((day) => ({ day, dayItems: items.filter((o) => agendaDate(o, zone).equals(day)) })).filter((d) => d.dayItems.length > 0);
  if (byDay.length === 0) return <p className="rounded-[14px] border border-line bg-surface px-5 py-8 text-center text-sm text-ink-2 shadow-xs">{emptyText}</p>;
  return (
    <ol className="divide-y divide-line rounded-[14px] border border-line bg-surface shadow-xs" data-testid="agenda">
      {byDay.map(({ day, dayItems }) => (
        <li key={day.toString()} className="grid gap-2 px-5 py-3 sm:grid-cols-[9rem_1fr]">
          <h3 className="text-sm font-semibold">{day.toLocaleString('en', { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
          <ul className="grid gap-1.5">
            {dayItems.map((o) => {
              const row = (
                <>
                  <span className="w-24 shrink-0 text-ink-2 tabular-nums">{o.allDay ? 'all day' : `${clockTime(o.start, zone)}–${clockTime(o.end, zone)}`}</span>
                  <ColorChip color={colorOf(o)} className="size-3 self-center" />
                  <span className="min-w-0">
                    <span className={cx('font-medium', o.cancelled && 'line-through')}>{o.title}</span>
                    {o.location && <span className="text-ink-3"> · {o.location}</span>}
                  </span>
                </>
              );
              return onSelect ? (
                <li key={o.key}>
                  <button type="button" onClick={() => onSelect(o)} className={cx(ROW, 'w-full rounded-md text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent')}>
                    {row}
                  </button>
                </li>
              ) : (
                <li key={o.key} className={ROW}>
                  {row}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}
