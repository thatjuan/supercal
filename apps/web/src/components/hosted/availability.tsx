/**
 * A hosted calendar's Availability tab: its busy time for one week, listed by day in this browser's
 * zone, from `POST /api/v1/free-busy`. It is all a `free-busy` grantee sees, so it names no event.
 */
import { Temporal } from '@js-temporal/polyfill';
import { useState } from 'react';
import { $api } from '../../api.ts';
import { browserZone } from '../../lib/zones.ts';
import { clockTime, weekOf, windowOf } from '../preview/layout.ts';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Icon } from '../ui/icon.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import type { CalendarTabProps } from './data.ts';

type Status = 'busy' | 'tentative';
type Interval = { start: string; end: string; status: Status };

const STATUS = {
  busy: { label: 'Busy', text: 'font-medium', mark: 'bg-ink-2' },
  tentative: { label: 'Tentative', text: 'italic text-ink-2', mark: 'border border-dashed border-ink-2' },
} as const satisfies Record<Status, { label: string; text: string; mark: string }>;

/** The intervals touching `day` in `zone`, cut at its midnights. A fully busy day reads as "All day". */
function intervalsOn(day: Temporal.PlainDate, intervals: readonly Interval[], zone: string) {
  const dayStart = day.toZonedDateTime(zone).toInstant();
  const dayEnd = day.add({ days: 1 }).toZonedDateTime(zone).toInstant();
  return intervals.flatMap(({ start, end, status }) => {
    const from = Temporal.Instant.from(start);
    const to = Temporal.Instant.from(end);
    if (Temporal.Instant.compare(from, dayEnd) >= 0 || Temporal.Instant.compare(to, dayStart) <= 0) return [];
    const startsBefore = Temporal.Instant.compare(from, dayStart) <= 0;
    const endsAfter = Temporal.Instant.compare(to, dayEnd) >= 0;
    const time = startsBefore && endsAfter ? 'All day' : `${clockTime((startsBefore ? dayStart : from).toString(), zone)}–${clockTime((endsAfter ? dayEnd : to).toString(), zone)}`;
    return [{ key: `${start}/${status}`, time, status }];
  });
}

export function AvailabilityTab({ loaded: { calendar } }: CalendarTabProps) {
  const [anchor, setAnchor] = useState(() => Temporal.Now.plainDateISO(browserZone));
  const days = weekOf(anchor);
  const query = $api.useQuery('post', '/api/v1/free-busy', { body: { ...windowOf(days, browserZone), calendarIds: [calendar.id] } });
  const result = query.data?.calendars[calendar.id];
  const range = `${days[0]?.toLocaleString('en', { month: 'short', day: 'numeric' })} – ${days[6]?.toLocaleString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center">
          <Button size="sm" variant="ghost" aria-label="Previous week" onClick={() => setAnchor((day) => day.subtract({ weeks: 1 }))}>
            <Icon name="chevron-left" className="size-4" />
          </Button>
          <Button size="sm" onClick={() => setAnchor(Temporal.Now.plainDateISO(browserZone))}>
            Today
          </Button>
          <Button size="sm" variant="ghost" aria-label="Next week" onClick={() => setAnchor((day) => day.add({ weeks: 1 }))}>
            <Icon name="chevron-right" className="size-4" />
          </Button>
        </div>
        <h2 className="mr-auto text-[17px] font-semibold tracking-tight">{range}</h2>
        <p className="text-[13px] text-ink-3">Times in {browserZone}</p>
      </div>

      {query.error && <ProblemAlert problem={toProblem(query.error)} />}
      {query.data &&
        (!result || 'error' in result ? (
          <p className="rounded-[14px] border border-line bg-surface px-5 py-8 text-center text-sm text-ink-2 shadow-xs">You can&rsquo;t see this calendar&rsquo;s availability.</p>
        ) : (
          <>
            {result.truncated && (
              <p role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
                This week has more events than could be checked, so this result may be incomplete.
              </p>
            )}
            <ol aria-label="Availability by day" className="divide-y divide-line rounded-[14px] border border-line bg-surface shadow-xs">
              {days.map((day) => {
                const label = day.toLocaleString('en', { weekday: 'long', month: 'short', day: 'numeric' });
                const intervals = intervalsOn(day, result.busy, browserZone);
                return (
                  <li key={day.toString()} aria-label={label} className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_1fr] sm:px-5">
                    <h3 className="text-sm font-semibold">{label}</h3>
                    {intervals.length === 0 ? (
                      <p className="text-sm text-ink-3">Free all day</p>
                    ) : (
                      <ul className="grid gap-1.5">
                        {intervals.map(({ key, time, status }) => (
                          <li key={key} className="flex items-baseline gap-3 text-sm">
                            <span className="w-24 shrink-0 text-ink-2 tabular-nums">{time}</span>
                            <span aria-hidden className={cx('size-3 shrink-0 self-center rounded-[3px]', STATUS[status].mark)} />
                            <span className={STATUS[status].text}>{STATUS[status].label}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        ))}
    </>
  );
}
