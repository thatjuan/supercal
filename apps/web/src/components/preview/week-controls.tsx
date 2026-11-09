/** The controls above a week view, for Preview and a hosted calendar's Events tab: previous, today, next, the range, week or agenda, and the zone. */
import { Temporal } from '@js-temporal/polyfill';
import { browserZone, ZONES } from '../../lib/zones.ts';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Icon } from '../ui/icon.tsx';

export type View = 'week' | 'agenda';

type Props = {
  days: Temporal.PlainDate[];
  view: View;
  onView: (view: View) => void;
  zone: string;
  onZone: (zone: string) => void;
  onAnchor: (update: (anchor: Temporal.PlainDate) => Temporal.PlainDate) => void;
};

export function WeekControls({ days, view, onView, zone, onZone, onAnchor }: Props) {
  const range = `${days[0]?.toLocaleString('en', { month: 'short', day: 'numeric' })} – ${days[6]?.toLocaleString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex items-center">
        <Button size="sm" variant="ghost" aria-label="Previous week" onClick={() => onAnchor((d) => d.subtract({ weeks: 1 }))}>
          <Icon name="chevron-left" className="size-4" />
        </Button>
        <Button size="sm" onClick={() => onAnchor(() => Temporal.Now.plainDateISO(zone))}>
          Today
        </Button>
        <Button size="sm" variant="ghost" aria-label="Next week" onClick={() => onAnchor((d) => d.add({ weeks: 1 }))}>
          <Icon name="chevron-right" className="size-4" />
        </Button>
      </div>
      <h2 className="mr-auto text-[17px] font-semibold tracking-tight">{range}</h2>
      <div role="group" aria-label="View" className="inline-flex rounded-[9px] border border-line bg-surface p-0.5 shadow-xs">
        {(['week', 'agenda'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={cx('h-7 rounded-[7px] px-3 text-[13px] font-medium capitalize', view === v ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink')}
          >
            {v}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink-2">
        Time zone
        <select value={zone} onChange={(e) => onZone(e.target.value)} className="h-8 max-w-48 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink shadow-xs">
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {z === browserZone ? `${z} (this browser)` : z}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
