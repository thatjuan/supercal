/**
 * The sheet for a selected occurrence: its details, loaded with the event's ETag, then editing or
 * deleting it. A recurring event first asks which occurrences the action covers. Instances stored
 * with no master can only be deleted whole; the app that created them edits them.
 */
import { Temporal } from '@js-temporal/polyfill';
import type { Problem } from '@supercal/api-client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { isProblem } from '../../../api.ts';
import { Sheet } from '../../calendars/sheet.tsx';
import { allDayDates, clockTime } from '../../preview/layout.ts';
import { Button } from '../../ui/button.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { Dialog, DialogClose, DialogContent } from '../../ui/dialog.tsx';
import { ProblemAlert, toProblem } from '../../ui/problem-alert.tsx';
import type { HostedCalendar } from '../data.ts';
import { EventEditor } from './event-editor.tsx';
import { eventForm, REMINDER_OFFSETS, repeatSummary, type EventForm, type JSEvent } from './form.ts';
import { canSplit, eventPatch, followingEvent, occurrenceEvent, occurrencePatch, overrideKey, overridePatch } from './patch.ts';
import { deleteEvent, deleteFollowing, eventKey, fetchEvent, patchEvent, splitEvent, useRefreshEvents, type CalendarOccurrence, type JSCalendar, type LoadedEvent } from './writes.ts';

/** Which occurrences an action covers. An event that doesn't repeat is always `all`. */
type Scope = 'this' | 'following' | 'all';
type Action = 'edit' | 'delete';

/** What a form for `scope` starts from. */
function scopedEvent(event: JSEvent, scope: Scope, key: string): JSEvent {
  if (scope === 'this') return occurrenceEvent(event, key);
  return scope === 'following' ? followingEvent(event, key) : event;
}

/** The Event a selected occurrence belongs to: a Group's entry for its `recurrenceId`, or the event itself. */
function entryOf(data: JSCalendar, key: string): JSEvent | undefined {
  if (data['@type'] !== 'Group') return data;
  return data.entries.find((entry) => entry.recurrenceId === key) ?? data.entries[0];
}

const dayLabel = (date: Temporal.PlainDate) => date.toLocaleString('en', { weekday: 'short', month: 'short', day: 'numeric' });

/** When the occurrence happens, in `zone`; an `endTimeZone` shows the end in that zone. */
function whenOf(occurrence: CalendarOccurrence, zone: string, endZone: string | undefined): string {
  if (occurrence.allDay) {
    const { start, end } = allDayDates(occurrence);
    const last = end.subtract({ days: 1 });
    return last.equals(start) ? `${dayLabel(start)}, all day` : `${dayLabel(start)} – ${dayLabel(last)}, all day`;
  }
  const dateIn = (iso: string, z: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(z).toPlainDate();
  const start = `${dayLabel(dateIn(occurrence.start, zone))}, ${clockTime(occurrence.start, zone)}`;
  const shownEndZone = endZone ?? zone;
  const end = clockTime(occurrence.end, shownEndZone);
  const sameDay = dateIn(occurrence.start, zone).equals(dateIn(occurrence.end, shownEndZone));
  return `${start} – ${sameDay ? '' : `${dayLabel(dateIn(occurrence.end, shownEndZone))}, `}${end}${endZone ? ` (${endZone})` : ''}`;
}

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function reminderLabel(alert: NonNullable<JSEvent['alerts']>[string]): string {
  if (alert.trigger['@type'] !== 'OffsetTrigger') return alert.trigger.when;
  const { offset } = alert.trigger;
  return REMINDER_OFFSETS.find((option) => option.offset === offset)?.label ?? offset;
}

/** The people on an event. Attendees aren't editable here, and nothing the dashboard does contacts them. */
function Participants({ event }: { event: JSEvent }) {
  const people = Object.entries(event.participants ?? {});
  if (people.length === 0) return null;
  return (
    <div className="grid gap-1.5 text-sm">
      <p className="font-semibold">Attendees</p>
      <ul className="grid gap-0.5">
        {people.map(([id, person]) => (
          <li key={id} className="wrap-anywhere">
            {person.name ?? person.email ?? person.calendarAddress?.replace(/^mailto:/i, '') ?? id}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-ink-3">Supercal doesn&rsquo;t send invitations.</p>
    </div>
  );
}

function Details({ event, occurrence, series, zone }: { event: JSEvent; occurrence: CalendarOccurrence; series: JSEvent; zone: string }) {
  const alerts = Object.values(event.alerts ?? {});
  const rows = [
    ['When', whenOf(occurrence, zone, event.endTimeZone)],
    ['Repeats', series.recurrenceRule && repeatSummary(series.recurrenceRule)],
    ['Location', occurrence.location],
    ['Description', event.description],
    ['Status', event.status && capitalized(event.status)],
    ['Show as', event.freeBusyStatus && capitalized(event.freeBusyStatus)],
    ['Visibility', event.privacy && capitalized(event.privacy)],
    ['Reminders', alerts.map(reminderLabel).join(', ')],
  ] as const;
  return (
    <dl className="grid gap-x-3 gap-y-2.5 text-sm sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold">{label}</dt>
            <dd className="whitespace-pre-wrap wrap-anywhere">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

const CHOICES: Record<Scope, string> = { this: 'This event', following: 'This and following', all: 'All events' };

function ScopePrompt({ action, splittable, onPick, onCancel }: { action: Action; splittable: boolean; onPick: (scope: Scope) => void; onCancel: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent title={action === 'edit' ? 'Edit a repeating event' : 'Delete a repeating event'} description="Which occurrences should this change?">
        <div className="grid gap-2">
          {(['this', 'following', 'all'] as const)
            .filter((scope) => scope !== 'following' || splittable)
            .map((scope) => (
              <Button key={scope} onClick={() => onPick(scope)}>
                {CHOICES[scope]}
              </Button>
            ))}
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CONFIRM: Record<Scope, string> = {
  this: 'Only this occurrence is removed. The rest of the series stays.',
  following: 'This occurrence and all later ones are removed. Earlier ones stay.',
  all: 'The event is removed, including every occurrence and from calendar apps.',
};

/** A stale delete says so in the same words as a stale edit. */
const deleteProblem = (failure: unknown): Problem =>
  isProblem(failure) && failure.status === 412 ? { ...failure, title: 'This event changed elsewhere', detail: 'Check its details before deleting it.' } : toProblem(failure);

type Props = { calendar: HostedCalendar; canWrite: boolean; zone: string; occurrence: CalendarOccurrence; onClose: () => void };

export function OccurrenceSheet({ calendar, canWrite, zone, occurrence, onClose }: Props) {
  const id = calendar.id;
  const uid = occurrence.uid;
  const key = overrideKey(occurrence.recurrenceId);
  const refresh = useRefreshEvents();
  const query = useQuery({ queryKey: eventKey(id, uid), queryFn: () => fetchEvent(id, uid) });
  const [asking, setAsking] = useState<Action | null>(null);
  /** The version being edited, frozen: the live query can move on, and saving then fails with 412. */
  const [editing, setEditing] = useState<{ base: LoadedEvent & { event: JSEvent }; scope: Scope } | null>(null);
  const [deleting, setDeleting] = useState<Scope | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const loaded = query.data;
  const entry = loaded && entryOf(loaded.data, key);
  const fallbackZone = calendar.timezone ?? zone;
  const formFor = (event: JSEvent, scope: Scope): EventForm => eventForm(scopedEvent(event, scope, key), fallbackZone);

  /** No master: `PATCH` would answer 409 `event-has-no-master`, so only the whole object can be deleted. */
  const detached = !loaded || !entry || loaded.data['@type'] === 'Group' || entry.recurrenceId !== undefined;
  const recurring = !detached && entry.recurrenceRule !== undefined;
  const shown = entry && recurring ? occurrenceEvent(entry, key) : entry;

  function act(action: Action, scope: Scope) {
    setAsking(null);
    if (action === 'delete') return setDeleting(scope);
    if (loaded && entry) setEditing({ base: { ...loaded, event: entry }, scope });
  }

  /** Writes the form for the scope; a form with no changes writes nothing. */
  async function save(form: EventForm) {
    if (!editing) return;
    const { base, scope } = editing;
    const patch = scope === 'this' ? occurrencePatch(base.event, key, form) : eventPatch(scopedEvent(base.event, scope, key), form);
    if (Object.keys(patch).length > 0) {
      if (scope === 'following') await splitEvent(id, uid, base.etag, key, patch);
      else await patchEvent(id, uid, base.etag, patch);
    }
    onClose();
    await refresh();
  }

  async function reload(): Promise<EventForm> {
    const latest = await query.refetch({ throwOnError: true });
    const event = latest.data && entryOf(latest.data.data, key);
    if (!latest.data || !event || !editing) throw new Error('This event is gone');
    setEditing({ ...editing, base: { ...latest.data, event } });
    return formFor(event, editing.scope);
  }

  async function confirmDelete(scope: Scope) {
    if (!loaded || !entry) return;
    setProblem(null);
    try {
      if (scope === 'this') await patchEvent(id, uid, loaded.etag, overridePatch(entry, key, { excluded: true }));
      else if (scope === 'following') await deleteFollowing(id, uid, loaded.etag, key);
      else await deleteEvent(id, uid, loaded.etag);
    } catch (failure) {
      setProblem(deleteProblem(failure));
      void refresh();
      throw failure;
    }
    onClose();
    await refresh();
  }

  const title = editing ? 'Edit event' : shown?.title || occurrence.title;
  return (
    <Sheet open onOpenChange={onClose} title={title}>
      {editing ? (
        <EventEditor initial={formFor(editing.base.event, editing.scope)} submitLabel="Save" seriesFields={editing.scope !== 'this'} save={save} onCancel={() => setEditing(null)} reload={reload}>
          <Participants event={editing.base.event} />
        </EventEditor>
      ) : (
        <div className="grid gap-5 px-5 py-4">
          {query.error && <ProblemAlert problem={toProblem(query.error)} />}
          {entry && shown && (
            <>
              <Details event={shown} occurrence={occurrence} series={entry} zone={zone} />
              <Participants event={entry} />
              {detached && <p className="text-[13px] text-ink-3">Edit this event in the app that created it</p>}
              {canWrite && (
                <div className="flex justify-end gap-2">
                  <Button variant="danger" onClick={() => (recurring ? setAsking('delete') : setDeleting('all'))}>
                    Delete
                  </Button>
                  {!detached && (
                    <Button variant="primary" onClick={() => (recurring ? setAsking('edit') : act('edit', 'all'))}>
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {asking && entry && <ScopePrompt action={asking} splittable={canSplit(entry, key)} onPick={(scope) => act(asking, scope)} onCancel={() => setAsking(null)} />}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setDeleting(null);
              setProblem(null);
            }
          }}
          title={`Delete “${title}”?`}
          description={CONFIRM[deleting]}
          confirmLabel="Delete"
          danger
          error={problem}
          onConfirm={() => confirmDelete(deleting)}
        />
      )}
    </Sheet>
  );
}
