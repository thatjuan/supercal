/**
 * A writable calendar's Events tab: the week or agenda of its occurrences, and the sheets that show,
 * create and edit them. Without write access, or on a deleted calendar, it is read-only. Calendar
 * apps edit the same events over CalDAV, and the live stream brings their changes in.
 */
import { Temporal } from '@js-temporal/polyfill';
import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { $api } from '../../../api.ts';
import { browserZone } from '../../../lib/zones.ts';
import { Sheet } from '../../calendars/sheet.tsx';
import { FALLBACK_COLOR } from '../../calendars/settings-fields.tsx';
import { Agenda } from '../../preview/agenda.tsx';
import { weekOf, windowOf } from '../../preview/layout.ts';
import { WeekControls, type View } from '../../preview/week-controls.tsx';
import { WeekGrid } from '../../preview/week-grid.tsx';
import { Button } from '../../ui/button.tsx';
import { Icon } from '../../ui/icon.tsx';
import { ProblemAlert, toProblem } from '../../ui/problem-alert.tsx';
import { atLeast, type CalendarTabProps, type Calendar } from '../data.ts';
import { EventEditor } from './event-editor.tsx';
import { OccurrenceSheet } from './occurrence-sheet.tsx';
import { newEventBody, newEventForm, type EventForm } from './form.ts';
import { createEvent, useRefreshEvents, type CalendarOccurrence } from './writes.ts';

export function EventsTab({ loaded: { calendar } }: CalendarTabProps) {
  const id = calendar.id;
  const canWrite = calendar.writable && atLeast(calendar.access, 'write') && calendar.state === 'active';
  const [view, setView] = useState<View>('week');
  const [zone, setZone] = useState(browserZone);
  const [anchor, setAnchor] = useState(() => Temporal.Now.plainDateISO(browserZone));
  const [selected, setSelected] = useState<CalendarOccurrence | null>(null);
  const [draft, setDraft] = useState<EventForm | null>(null);

  const days = weekOf(anchor);
  const occurrences = $api.useQuery('get', '/api/v1/calendars/{id}/occurrences', { params: { path: { id }, query: windowOf(days, zone) } }, { placeholderData: keepPreviousData });
  const items = (occurrences.data?.items ?? []).map((o) => ({ ...o, key: `${o.uid}/${o.recurrenceId}`, title: o.title || '(No title)', cancelled: o.status === 'cancelled' }));
  const colorOf = () => calendar.color ?? FALLBACK_COLOR;
  const views = { days, items, zone, colorOf, onSelect: setSelected };

  return (
    <>
      {canWrite && (
        <div className="mb-4 flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setDraft(newEventForm(days, calendar.timezone ?? browserZone))}>
            <Icon name="plus" className="size-4" />
            New event
          </Button>
        </div>
      )}
      <WeekControls days={days} view={view} onView={setView} zone={zone} onZone={setZone} onAnchor={setAnchor} />
      {occurrences.error && <ProblemAlert problem={toProblem(occurrences.error)} className="mb-4" />}
      {occurrences.data?.truncated && (
        <p role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          This view is incomplete: the calendar has more events in this period than can be shown.
        </p>
      )}
      {view === 'week' ? <WeekGrid {...views} /> : <Agenda {...views} emptyText="No events this week." />}
      {draft && <NewEventSheet calendar={calendar} draft={draft} onClose={() => setDraft(null)} />}
      {selected && <OccurrenceSheet key={`${selected.uid}/${selected.recurrenceId}`} calendar={calendar} canWrite={canWrite} zone={zone} occurrence={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function NewEventSheet({ calendar, draft, onClose }: { calendar: Calendar; draft: EventForm; onClose: () => void }) {
  const refresh = useRefreshEvents();
  return (
    <Sheet open onOpenChange={onClose} title="New event">
      <EventEditor
        initial={draft}
        submitLabel="Create event"
        seriesFields
        onCancel={onClose}
        save={async (form) => {
          await createEvent(calendar.id, newEventBody(form));
          onClose();
          await refresh();
        }}
      />
    </Sheet>
  );
}
