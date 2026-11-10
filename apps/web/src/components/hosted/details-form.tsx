/**
 * A hosted calendar's details. Below `manage` they are read-only. Above it, saving sends only what
 * changed, with the `If-Match` of the version the form started from. An untouched form follows the
 * live copy; once the user has typed, it stays on its version, and a 412 keeps what they typed
 * until they choose to reload.
 */
import type { Problem } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { client, isProblem } from '../../api.ts';
import { useRefreshFeeds } from '../calendars/data.ts';
import { FALLBACK_COLOR } from '../calendars/settings-fields.tsx';
import { Button } from '../ui/button.tsx';
import { ColorChip } from '../ui/calendar-color.tsx';
import { Panel } from '../ui/panel.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { CalendarFields, NAME_MISSING, type CalendarValues } from './calendar-fields.tsx';
import { atLeast, hostedCalendarKey, type CalendarTabProps, type Calendar, type LoadedCalendar } from './data.ts';

type Props = Pick<CalendarTabProps, 'loaded' | 'reload'>;

const ZONE_HINT = 'Changing this does not recompute the time span of events with no time zone of their own.';

const valuesOf = (calendar: Calendar): CalendarValues => ({ name: calendar.name, color: calendar.color, timezone: calendar.timezone, description: calendar.description ?? '' });

/** What differs from `base`, in the API's shape: colours lowercase, and no field the API cannot take (a null colour or zone). */
const changedFields = (base: CalendarValues, values: CalendarValues) => {
  const name = values.name.trim();
  const color = values.color?.toLowerCase();
  return {
    ...(name !== base.name && { name }),
    ...(color && color !== base.color?.toLowerCase() && { color }),
    ...(values.timezone && values.timezone !== base.timezone && { timezone: values.timezone }),
    ...(values.description !== base.description && { description: values.description }),
  };
};

export function DetailsForm({ loaded, reload }: Props) {
  return (
    <Panel title="Details">
      {atLeast(loaded.calendar.access, 'manage') && loaded.calendar.state === 'active' ? <EditableDetails loaded={loaded} reload={reload} /> : <ReadOnlyDetails calendar={loaded.calendar} />}
    </Panel>
  );
}

function ReadOnlyDetails({ calendar }: { calendar: Calendar }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="font-semibold">Name</dt>
      <dd className="wrap-anywhere">{calendar.name}</dd>
      <dt className="font-semibold">Colour</dt>
      <dd>
        <ColorChip color={calendar.color ?? FALLBACK_COLOR} />
      </dd>
      <dt className="font-semibold">Time zone</dt>
      <dd>{calendar.timezone ?? 'Not set'}</dd>
      <dt className="font-semibold">Description</dt>
      <dd className="whitespace-pre-wrap wrap-anywhere">{calendar.description || 'None'}</dd>
    </dl>
  );
}

function EditableDetails({ loaded, reload }: Props) {
  const queryClient = useQueryClient();
  const refresh = useRefreshFeeds();
  const [base, setBase] = useState(loaded);
  const [values, setValues] = useState(() => valuesOf(loaded.calendar));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState(false);

  const id = base.calendar.id;
  const baseValues = valuesOf(base.calendar);
  const patch = changedFields(baseValues, values);
  const dirty = Object.keys(patch).length > 0;
  const name = values.name.trim();

  const adopt = (next: LoadedCalendar) => {
    setBase(next);
    setValues(valuesOf(next.calendar));
    setTried(false);
    setConflict(false);
    setProblem(null);
  };

  // Nothing unsaved: follow what the live stream brings in, but never step back to an older copy.
  if (!dirty && !saving && Date.parse(loaded.calendar.updatedAt ?? '') > Date.parse(base.calendar.updatedAt ?? '')) adopt(loaded);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    setSaved(false);
    if (name === '' || !dirty) return;
    setSaving(true);
    setProblem(null);
    setConflict(false);
    try {
      const { data, error, response } = await client.PATCH('/api/v1/calendars/{id}', {
        params: { path: { id }, ...(base.etag && { header: { 'if-match': base.etag } }) },
        body: patch,
      });
      if (error) throw error;
      if (data.kind !== 'hosted') return;
      const next = { calendar: data, etag: response.headers.get('etag') ?? '' };
      queryClient.setQueryData(hostedCalendarKey(id), next);
      adopt(next);
      setSaved(true);
      void refresh();
    } catch (failure) {
      if (isProblem(failure) && failure.status === 412) setConflict(true);
      else setProblem(toProblem(failure));
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    const latest = await reload();
    if (latest) adopt(latest);
  }

  const errors = fieldErrors(problem);
  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      {problem && <ProblemAlert problem={problem} />}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          This calendar changed elsewhere
          <Button size="sm" onClick={() => void reloadLatest()}>
            Reload
          </Button>
        </div>
      )}
      {/* The colour field keeps its own text, so a new base version remounts it. */}
      <CalendarFields key={base.etag} values={values} onChange={setValues} nameError={tried && name === '' ? NAME_MISSING : errors.name} descriptionError={errors.description} zoneHint={ZONE_HINT} />
      <div className="flex items-center justify-end gap-3">
        {saved && !dirty && (
          <p role="status" className="text-[13px] text-ink-2">
            Saved
          </p>
        )}
        <Button type="submit" variant="primary" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
