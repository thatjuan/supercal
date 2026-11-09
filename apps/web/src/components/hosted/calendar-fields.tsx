/** The fields of a hosted calendar, shared by the New calendar dialog and the Settings tab. Controlled: it edits a `CalendarValues`. */
import { useId } from 'react';
import { browserZone, ZONES } from '../../lib/zones.ts';
import { ColorField, PALETTE } from '../calendars/settings-fields.tsx';
import { Field } from '../ui/field.tsx';

export type CalendarValues = { name: string; color: string | null; timezone: string | null; description: string };

type Props = {
  values: CalendarValues;
  onChange: (values: CalendarValues) => void;
  nameError?: string | undefined;
  descriptionError?: string | undefined;
  zoneHint?: string;
};

export const NAME_MISSING = 'Give it a name';

/** A calendar always has a colour here, so clearing the hex input falls back to the palette instead of "no colour". */
export function CalendarFields({ values, onChange, nameError, descriptionError, zoneHint }: Props) {
  const zoneId = useId();
  const descriptionId = useId();
  const set = <K extends keyof CalendarValues>(key: K, next: CalendarValues[K]) => onChange({ ...values, [key]: next });
  // An API client can set a zone this browser does not list; it must stay selectable.
  const zones = values.timezone && !ZONES.includes(values.timezone) ? [values.timezone, ...ZONES] : ZONES;
  return (
    <div className="grid gap-4">
      <Field label="Name" value={values.name} error={nameError} maxLength={100} onChange={(e) => set('name', e.target.value)} />
      <ColorField value={values.color} fallback={PALETTE[0]} onChange={(color) => set('color', color ?? PALETTE[0])} />
      <div className="grid gap-1.5">
        <label htmlFor={zoneId} className="text-sm font-semibold">
          Time zone
        </label>
        <select
          id={zoneId}
          aria-describedby={zoneHint ? `${zoneId}-hint` : undefined}
          value={values.timezone ?? ''}
          onChange={(e) => set('timezone', e.target.value)}
          className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[15px] text-ink shadow-xs"
        >
          {values.timezone === null && <option value="">Not set</option>}
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone === browserZone ? `${zone} (this browser)` : zone}
            </option>
          ))}
        </select>
        {zoneHint && (
          <p id={`${zoneId}-hint`} className="text-[13px] text-ink-3">
            {zoneHint}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={descriptionId} className="text-sm font-semibold">
          Description
        </label>
        <textarea
          id={descriptionId}
          value={values.description}
          maxLength={10_000}
          aria-invalid={descriptionError ? true : undefined}
          onChange={(e) => set('description', e.target.value)}
          className="max-h-[12lh] min-h-[3lh] w-full resize-none rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[15px] text-ink shadow-xs [field-sizing:content] placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none aria-invalid:border-danger"
        />
        {descriptionError && <p className="text-[13px] text-danger">{descriptionError}</p>}
      </div>
    </div>
  );
}
