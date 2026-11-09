/**
 * Privacy levels (architecture §5): what each one publishes, as a badge for lists and as a picker
 * whose options explain themselves with a mini preview of one example event.
 */
import { EventBlock } from '../ui/calendar-color.tsx';
import { Badge } from '../ui/badge.tsx';
import { cx } from '../ui/cx.ts';
import type { Privacy } from './data.ts';

export const PRIVACY = {
  full: { label: 'Full', tone: 'accent', explanation: 'All event details: title, time, location and notes.' },
  'title-only': { label: 'Title only', tone: 'info', explanation: 'Event title and time, no other details.' },
  'busy-only': { label: 'Busy only', tone: 'violet', explanation: 'Only time blocks, shown as “Busy”.' },
} as const satisfies Record<Privacy, { label: string; tone: string; explanation: string }>;

const LEVELS = Object.keys(PRIVACY) as Privacy[];

/** The example event every option previews. */
const EXAMPLE = { title: 'Design review', time: '10:00–11:00', location: 'Room 4B' };

export function PrivacyBadge({ privacy }: { privacy: Privacy }) {
  const { label, tone } = PRIVACY[privacy];
  return <Badge tone={tone}>{label}</Badge>;
}

/** How the example event renders under `privacy`. */
export function PrivacyExample({ privacy, color }: { privacy: Privacy; color: string }) {
  const title = privacy === 'busy-only' ? 'Busy' : EXAMPLE.title;
  const meta = privacy === 'full' ? `${EXAMPLE.time} · ${EXAMPLE.location}` : EXAMPLE.time;
  return <EventBlock color={color} title={title} meta={meta} className="w-full" />;
}

/** A radio group of the three levels, each with its explanation and preview. `null` selects none, for a choice with no default. */
export function PrivacyPicker({ value, onChange, color }: { value: Privacy | null; onChange: (privacy: Privacy) => void; color: string }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-sm font-semibold">Privacy</legend>
      {LEVELS.map((level) => (
        <label
          key={level}
          className={cx(
            'grid cursor-pointer grid-cols-[auto_1fr_9.5rem] items-center gap-3 rounded-[10px] border px-3 py-2.5',
            value === level ? 'border-accent bg-accent-soft/40 ring-1 ring-accent' : 'border-line hover:bg-surface-2',
          )}
        >
          <input type="radio" name="privacy" value={level} checked={value === level} onChange={() => onChange(level)} className="accent-[var(--accent)]" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{PRIVACY[level].label}</span>
            <span className="block text-[13px] text-ink-3">{PRIVACY[level].explanation}</span>
          </span>
          <span data-testid={`privacy-example-${level}`}>
            <PrivacyExample privacy={level} color={color} />
          </span>
        </label>
      ))}
    </fieldset>
  );
}
