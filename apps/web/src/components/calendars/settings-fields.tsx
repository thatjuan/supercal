/**
 * The publication settings form body shared by the settings drawer and the virtual calendar
 * builder: name, colour, privacy, filters and reminders. Controlled: it edits a `Settings` value.
 */
import { useId, useState, type ReactNode } from 'react';
import { ColorChip } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { Field, Input } from '../ui/field.tsx';
import { PrivacyPicker } from './privacy.tsx';
import type { Settings } from './settings.ts';

/** Calendar colours offered as swatches; any `#RRGGBB` can be typed instead. */
export const PALETTE = ['#2f80ed', '#9b51e0', '#eb5757', '#f2994a', '#f2c94c', '#27ae60', '#00a3a3', '#e05297', '#6b7280'] as const;
const HEX = /^#[0-9a-f]{6}$/i;
export const FALLBACK_COLOR = '#6b7280';

export function Checkbox({ label, hint, checked, onChange }: { label: ReactNode; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
      <span>
        {label}
        {hint && <span className="block text-[13px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

/** Palette swatches plus a hex input; `null` means "the calendar's own colour". */
export function ColorField({ value, onChange, fallback }: { value: string | null; onChange: (color: string | null) => void; fallback: string | null }) {
  const id = useId();
  const [text, setText] = useState(value ?? '');
  const choose = (color: string | null) => {
    setText(color ?? '');
    onChange(color);
  };
  const invalid = text !== '' && !HEX.test(text);
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm font-semibold">Colour</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        {PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={value?.toLowerCase() === color}
            onClick={() => choose(color)}
            className={cx('rounded-[7px] p-0.5 ring-offset-1', value?.toLowerCase() === color && 'ring-2 ring-ink')}
          >
            <ColorChip color={color} className="block size-6" />
          </button>
        ))}
        <div className="ml-1 flex items-center gap-2">
          <ColorChip color={value ?? fallback ?? FALLBACK_COLOR} className="size-6" />
          <label htmlFor={id} className="sr-only">
            Hex colour
          </label>
          <Input
            id={id}
            value={text}
            placeholder={fallback ?? '#RRGGBB'}
            aria-invalid={invalid || undefined}
            onChange={(e) => {
              const next = e.target.value.trim();
              setText(next);
              if (next === '') onChange(null);
              else if (HEX.test(next)) onChange(next.toLowerCase());
            }}
            className="h-8 w-28 font-mono text-[13px]"
          />
        </div>
      </div>
      {invalid && <p className="text-[13px] text-danger">Use a colour like #2f80ed</p>}
    </fieldset>
  );
}

type FieldsProps = { value: Settings; onChange: (next: Settings) => void; fallbackColor: string | null; nameError?: string | undefined };

/** Name, colour, privacy, filters and reminders. `fallbackColor` is the source calendar's colour. */
export function SettingsFields({ value, onChange, fallbackColor, nameError }: FieldsProps) {
  const set = <K extends keyof Settings>(key: K, next: Settings[K]) => onChange({ ...value, [key]: next });
  const setFilter = (key: keyof Settings['filters'], on: boolean) => set('filters', { ...value.filters, [key]: on });
  return (
    <div className="grid gap-5">
      <Field label="Name" value={value.name} error={nameError} maxLength={100} onChange={(e) => set('name', e.target.value)} />
      <ColorField value={value.color} onChange={(color) => set('color', color)} fallback={fallbackColor} />
      <PrivacyPicker value={value.privacy} onChange={(privacy) => set('privacy', privacy)} color={value.color ?? fallbackColor ?? FALLBACK_COLOR} />
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-semibold">Filters</legend>
        <Checkbox label="Hide declined events" checked={value.filters.hideDeclined} onChange={(on) => setFilter('hideDeclined', on)} />
        <Checkbox label="Hide cancelled events" checked={value.filters.hideCancelled} onChange={(on) => setFilter('hideCancelled', on)} />
        <Checkbox label="Hide all-day events" checked={value.filters.hideAllDay} onChange={(on) => setFilter('hideAllDay', on)} />
      </fieldset>
      <Checkbox
        label="Keep reminders"
        hint="Publish the source’s alarms, so calendar apps alert you."
        checked={value.keepAlarms}
        onChange={(on) => set('keepAlarms', on)}
      />
    </div>
  );
}
