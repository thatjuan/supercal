/** The Hosted screen's sections: your calendars (drag to reorder), calendars shared with you, and deleted calendars awaiting purge. */
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { client } from '../../api.ts';
import { formatDate } from '../../lib/format.ts';
import { useRefreshFeeds } from '../calendars/data.ts';
import { FALLBACK_COLOR } from '../calendars/settings-fields.tsx';
import { SortableList } from '../calendars/sortable-list.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { ColorChip } from '../ui/calendar-color.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { useHostedCalendars, useRestoreCalendar, type Access, type HostedCalendar } from './data.ts';

const RETENTION_MS = 30 * 86_400_000;

const ACCESS_LABEL = { 'free-busy': 'Free/busy', read: 'Read', write: 'Write', manage: 'Manage', owner: 'Owner' } as const satisfies Record<Access, string>;

function CalendarName({ calendar, children }: { calendar: HostedCalendar; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ColorChip color={calendar.color ?? FALLBACK_COLOR} />
      <Link to="/hosted/$calendarId" params={{ calendarId: calendar.id }} className="truncate text-[15px] font-medium hover:underline">
        {calendar.name}
      </Link>
      {children}
    </span>
  );
}

export function HostedList({ onCreate }: { onCreate: () => void }) {
  const { mine, others, deleted, error, isPending } = useHostedCalendars();
  if (error) return <ProblemAlert problem={toProblem(error)} className="max-w-2xl" />;
  if (isPending) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <YourCalendars mine={mine} onCreate={onCreate} />
      {others.length > 0 && <SharedWithYou others={others} />}
      {deleted.length > 0 && <Deleted deleted={deleted} />}
    </div>
  );
}

function YourCalendars({ mine, onCreate }: { mine: HostedCalendar[]; onCreate: () => void }) {
  const refresh = useRefreshFeeds();
  // The order being saved, shown until the refetch that follows it lands.
  const [saving, setSaving] = useState<HostedCalendar[] | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const shown = saving ?? mine;

  async function reorder(next: HostedCalendar[]) {
    if (saving) return;
    setSaving(next);
    setProblem(null);
    try {
      for (const [sortOrder, calendar] of next.entries()) {
        if (calendar.sortOrder === sortOrder) continue;
        const { error } = await client.PATCH('/api/v1/calendars/{id}', { params: { path: { id: calendar.id } }, body: { sortOrder } });
        if (error) throw error;
      }
    } catch (failure) {
      setProblem(failure);
    }
    await refresh();
    setSaving(null);
  }

  return (
    <Panel title="Your calendars">
      {problem !== null && <ProblemAlert problem={toProblem(problem)} className="mb-3" />}
      {shown.length === 0 ? (
        <div className="grid justify-items-start gap-3">
          <p className="text-sm text-ink-2">A hosted calendar keeps its events in Supercal, with no provider behind it.</p>
          <Button variant="primary" onClick={onCreate}>
            New calendar
          </Button>
        </div>
      ) : (
        <SortableList
          label="Your calendars"
          items={shown}
          keyOf={(calendar) => calendar.id}
          labelOf={(calendar) => calendar.name}
          onReorder={(next) => void reorder(next)}
          className="-my-1.5"
        >
          {(calendar) => (
            <span className="flex min-w-0 items-center justify-between gap-4">
              <CalendarName calendar={calendar} />
              <span className="shrink-0 text-[13px] text-ink-3">{calendar.timezone}</span>
            </span>
          )}
        </SortableList>
      )}
    </Panel>
  );
}

function SharedWithYou({ others }: { others: HostedCalendar[] }) {
  return (
    <Panel title="Shared with you">
      <ul className="-my-2 divide-y divide-line">
        {others.map((calendar) => (
          <li key={calendar.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
            <CalendarName calendar={calendar}>{calendar.state === 'gone' && <span className="shrink-0 text-[13px] text-warning">deleted</span>}</CalendarName>
            <span className="flex min-w-0 items-center gap-3">
              <span className="truncate text-[13px] text-ink-3">{calendar.owner.name}</span>
              <Badge>{ACCESS_LABEL[calendar.access]}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Deleted({ deleted }: { deleted: HostedCalendar[] }) {
  const { restore, isPending } = useRestoreCalendar();
  return (
    <Panel title="Deleted">
      <ul className="-my-2 divide-y divide-line">
        {deleted.map((calendar) => (
          <li key={calendar.id} aria-label={calendar.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold wrap-anywhere">{calendar.name}</p>
              {calendar.goneAt && <p className="text-[13px] text-ink-3">Deleted permanently on {formatDate(new Date(Date.parse(calendar.goneAt) + RETENTION_MS).toISOString())}</p>}
            </div>
            <Button size="sm" disabled={isPending} onClick={() => restore(calendar.id)}>
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
