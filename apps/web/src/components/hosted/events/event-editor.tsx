/**
 * The event form. It edits a copy of `initial` and hands the values to `save`, which writes them and
 * throws on failure. A 412 keeps what was typed and offers `reload`, which replaces the form with
 * the latest event.
 */
import type { Problem } from '@supercal/api-client';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { isProblem } from '../../../api.ts';
import { browserZone, ZONES } from '../../../lib/zones.ts';
import { Checkbox } from '../../calendars/settings-fields.tsx';
import { Button } from '../../ui/button.tsx';
import { Field } from '../../ui/field.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../../ui/problem-alert.tsx';
import { CUSTOM_REPEAT, dayName, formErrors, moveStart, REMINDER_OFFSETS, unitOf, WEEKDAYS, type EventForm, type FormErrors, type Repeat } from './form.ts';

type Props = {
  initial: EventForm;
  submitLabel: string;
  /** Repeat and visibility belong to the series: an override of one occurrence cannot hold them. */
  seriesFields: boolean;
  save: (form: EventForm) => Promise<void>;
  onCancel: () => void;
  reload?: () => Promise<EventForm>;
  /** Shown between the fields and the buttons, such as read-only attendees. */
  children?: ReactNode;
};

const INPUT = 'h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[15px] text-ink shadow-xs';
const LABEL = 'text-sm font-semibold';

/** The form field a server error path belongs to. A patch failure's path is a JSON pointer, possibly into an override. */
const FIELD_OF_PATH: Partial<Record<string, 'title' | 'start' | 'end' | 'location' | 'description'>> = { title: 'title', start: 'start', duration: 'end', locations: 'location', mainLocationId: 'location', description: 'description' };
const fieldOfPath = (path: string) => FIELD_OF_PATH[path.replace(/^recurrenceOverrides\/[^/]+\//, '').split('/')[0] ?? ''];

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: readonly { value: string; label: string }[] }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** `options`, plus the current value if it came from elsewhere, so it stays selectable and saving leaves it alone. */
const withCurrent = (options: readonly { value: string; label: string }[], current: string) => (options.some((o) => o.value === current) ? options : [{ value: current, label: current }, ...options]);

const STATUSES = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'tentative', label: 'Tentative' },
  { value: 'cancelled', label: 'Cancelled' },
];
const SHOW_AS = [
  { value: 'busy', label: 'Busy' },
  { value: 'free', label: 'Free' },
];
const VISIBILITY = [
  { value: 'public', label: 'Public' },
  { value: 'private', label: 'Private' },
];
const FREQUENCY_OPTIONS = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
] as const;
const END_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'on', label: 'On a date' },
  { value: 'after', label: 'After a number of times' },
] as const;

function RepeatFields({ form: { repeat }, errors, set }: { form: EventForm; errors: FormErrors; set: (repeat: Repeat) => void }) {
  if (repeat.frequency === 'custom') {
    return (
      <div className="grid gap-1.5">
        <p className={LABEL}>Repeat</p>
        <p className="text-sm text-ink-2">{CUSTOM_REPEAT}</p>
      </div>
    );
  }
  const change = <K extends keyof Repeat>(key: K, value: Repeat[K]) => set({ ...repeat, [key]: value });
  return (
    <div className="grid gap-4">
      <SelectField
        label="Repeat"
        value={repeat.frequency}
        options={FREQUENCY_OPTIONS}
        onChange={(value) => {
          const option = FREQUENCY_OPTIONS.find((o) => o.value === value);
          if (option) change('frequency', option.value);
        }}
      />
      {repeat.frequency !== 'none' && (
        <>
          <Field label="Every" type="number" min={1} inputMode="numeric" value={repeat.interval} error={errors.interval} hint={`${unitOf(repeat.frequency)}(s)`} onChange={(e) => change('interval', e.target.value)} />
          {repeat.frequency === 'weekly' && (
            <fieldset className="grid gap-1.5">
              <legend className={LABEL}>On</legend>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                {WEEKDAYS.map((day) => (
                  <Checkbox key={day} label={dayName(day)} checked={repeat.weekdays.includes(day)} onChange={(on) => change('weekdays', on ? [...repeat.weekdays, day] : repeat.weekdays.filter((d) => d !== day))} />
                ))}
              </div>
              {errors.weekdays && <p className="text-[13px] text-danger">{errors.weekdays}</p>}
            </fieldset>
          )}
          <SelectField
            label="Ends"
            value={repeat.end}
            options={END_OPTIONS}
            onChange={(value) => {
              const option = END_OPTIONS.find((o) => o.value === value);
              if (option) change('end', option.value);
            }}
          />
          {repeat.end === 'on' && <Field label="Last date" type="date" value={repeat.until} error={errors.until} onChange={(e) => change('until', e.target.value)} />}
          {repeat.end === 'after' && <Field label="Times" type="number" min={1} inputMode="numeric" value={repeat.count} error={errors.count} onChange={(e) => change('count', e.target.value)} />}
        </>
      )}
    </div>
  );
}

function Reminders({ form, set }: { form: EventForm; set: (reminders: EventForm['reminders']) => void }) {
  const options = REMINDER_OFFSETS.map(({ offset, label }) => ({ value: offset, label }));
  return (
    <div className="grid gap-1.5">
      <p className={LABEL}>Reminders</p>
      {form.reminders.map((reminder, index) => (
        <div key={index} className="flex items-center gap-2">
          <select
            aria-label={`Reminder ${index + 1}`}
            value={reminder.offset}
            onChange={(e) => set(form.reminders.map((r, i) => (i === index ? { ...r, offset: e.target.value } : r)))}
            className={INPUT}
          >
            {withCurrent(options, reminder.offset).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button aria-label={`Remove reminder ${index + 1}`} onClick={() => set(form.reminders.filter((_, i) => i !== index))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => set([...form.reminders, { id: '', offset: '-PT10M' }])}>
          Add reminder
        </Button>
      </div>
    </div>
  );
}

export function EventEditor({ initial, submitLabel, seriesFields, save, onCancel, reload, children }: Props) {
  const descriptionId = useId();
  const [form, setForm] = useState(initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const local = tried ? formErrors(form) : {};
  const server = new Map(Object.entries(fieldErrors(problem)).map(([path, message]) => [fieldOfPath(path), message]));
  const unmapped = (problem?.errors ?? []).filter((error) => !fieldOfPath(error.path));
  // A form this browser's list doesn't cover, such as `Etc/UTC` from a calendar app, must keep its zone.
  const zones = [...new Set([form.zone, ...ZONES])].filter(Boolean).map((zone) => ({ value: zone, label: zone === browserZone ? `${zone} (this browser)` : zone }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (Object.keys(formErrors(form)).length > 0) return;
    setSaving(true);
    setProblem(null);
    setConflict(false);
    try {
      await save(form);
    } catch (failure) {
      if (isProblem(failure) && failure.status === 412) setConflict(true);
      else setProblem(toProblem(failure));
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (!reload) return;
    try {
      setForm(await reload());
      setConflict(false);
      setProblem(null);
      setTried(false);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4 px-5 py-4">
      {problem && <ProblemAlert problem={{ ...problem, errors: unmapped }} showFieldErrors />}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          This event changed elsewhere
          <Button size="sm" onClick={() => void reloadLatest()}>
            Reload
          </Button>
        </div>
      )}
      <Field label="Title" value={form.title} error={server.get('title')} onChange={(e) => set('title', e.target.value)} />
      <Checkbox label="All day" checked={form.allDay} onChange={(allDay) => set('allDay', allDay)} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" type="date" value={form.startDate} error={local.start ?? server.get('start')} onChange={(e) => setForm(moveStart(form, { startDate: e.target.value }))} />
        {!form.allDay && <Field label="Start time" type="time" value={form.startTime} onChange={(e) => setForm(moveStart(form, { startTime: e.target.value }))} />}
        <Field label="End date" type="date" value={form.endDate} error={local.end ?? server.get('end')} onChange={(e) => set('endDate', e.target.value)} />
        {!form.allDay && <Field label="End time" type="time" value={form.endTime} {...(form.endZone ? { hint: `In ${form.endZone}` } : {})} onChange={(e) => set('endTime', e.target.value)} />}
      </div>
      {!form.allDay && <SelectField label="Time zone" value={form.zone} options={form.zone ? zones : [{ value: '', label: 'No time zone' }, ...zones]} onChange={(zone) => set('zone', zone)} />}
      <Field label="Location" value={form.location} error={server.get('location')} onChange={(e) => set('location', e.target.value)} />
      <div className="grid gap-1.5">
        <label htmlFor={descriptionId} className={LABEL}>
          Description
        </label>
        <textarea
          id={descriptionId}
          value={form.description}
          aria-invalid={server.has('description') ? true : undefined}
          onChange={(e) => set('description', e.target.value)}
          className="max-h-[12lh] min-h-[3lh] w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[15px] text-ink shadow-xs [field-sizing:content] placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none aria-invalid:border-danger"
        />
        {server.get('description') && <p className="text-[13px] text-danger">{server.get('description')}</p>}
      </div>
      {seriesFields && <RepeatFields form={form} errors={local} set={(repeat) => set('repeat', repeat)} />}
      <div className="grid grid-cols-2 gap-3">
        <SelectField label="Status" value={form.status} options={withCurrent(STATUSES, form.status)} onChange={(status) => set('status', status)} />
        <SelectField label="Show as" value={form.freeBusyStatus} options={withCurrent(SHOW_AS, form.freeBusyStatus)} onChange={(freeBusyStatus) => set('freeBusyStatus', freeBusyStatus)} />
      </div>
      {seriesFields && <SelectField label="Visibility" value={form.privacy} options={withCurrent(VISIBILITY, form.privacy)} onChange={(privacy) => set('privacy', privacy)} />}
      <Reminders form={form} set={(reminders) => set('reminders', reminders)} />
      {children}
      <footer className="sticky bottom-0 -mx-5 -mb-4 flex justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </footer>
    </form>
  );
}
