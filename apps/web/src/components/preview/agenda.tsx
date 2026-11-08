/** The preview's agenda view: the window's occurrences listed by local day. */
import type { Temporal } from '@js-temporal/polyfill';
import { ColorChip } from '../ui/calendar-color.tsx';
import { agendaDate, clockTime, type Occurrence } from './layout.ts';

type Props = { days: Temporal.PlainDate[]; occurrences: Occurrence[]; zone: string; colorOf: (o: Occurrence) => string };

export function Agenda({ days, occurrences, zone, colorOf }: Props) {
  const byDay = days.map((day) => ({ day, items: occurrences.filter((o) => agendaDate(o, zone).equals(day)) })).filter((d) => d.items.length > 0);
  if (byDay.length === 0) return <p className="rounded-[14px] border border-line bg-surface px-5 py-8 text-center text-sm text-ink-2 shadow-xs">Nothing published this week.</p>;
  return (
    <ol className="divide-y divide-line rounded-[14px] border border-line bg-surface shadow-xs" data-testid="agenda">
      {byDay.map(({ day, items }) => (
        <li key={day.toString()} className="grid gap-2 px-5 py-3 sm:grid-cols-[9rem_1fr]">
          <h3 className="text-sm font-semibold">{day.toLocaleString('en', { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
          <ul className="grid gap-1.5">
            {items.map((o) => (
              <li key={`${o.publicationId}/${o.outputUid}/${o.recurrenceId}`} className="flex items-baseline gap-3 text-sm">
                <span className="w-24 shrink-0 text-ink-2 tabular-nums">{o.allDay ? 'all day' : `${clockTime(o.start, zone)}–${clockTime(o.end, zone)}`}</span>
                <ColorChip color={colorOf(o)} className="size-3 self-center" />
                <span className="min-w-0">
                  <span className="font-medium">{o.summary}</span>
                  {o.location && <span className="text-ink-3"> · {o.location}</span>}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
