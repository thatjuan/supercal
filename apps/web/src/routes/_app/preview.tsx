/**
 * Preview (product screen 7): exactly what the selected feed publishes this week, from
 * `GET /feeds/{id}/occurrences`, as a week grid or an agenda. The live stream invalidates the query,
 * so source changes show without a reload. Legend toggles hide publications locally only.
 */
import { Temporal } from '@js-temporal/polyfill';
import { keepPreviousData } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { $api } from '../../api.ts';
import { browserZone, ZONES } from '../../lib/zones.ts';
import { feedSearch, useFeedCalendars, useFeeds, type Publication } from '../../components/calendars/data.ts';
import { FeedPicker } from '../../components/calendars/feed-picker.tsx';
import { FALLBACK_COLOR } from '../../components/calendars/settings-fields.tsx';
import { PageHeader } from '../../components/page-header.tsx';
import { Agenda } from '../../components/preview/agenda.tsx';
import { weekOf, windowOf, type Occurrence } from '../../components/preview/layout.ts';
import { WeekGrid } from '../../components/preview/week-grid.tsx';
import { Button } from '../../components/ui/button.tsx';
import { ColorChip } from '../../components/ui/calendar-color.tsx';
import { cx } from '../../components/ui/cx.ts';
import { Icon } from '../../components/ui/icon.tsx';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/preview')({ validateSearch: feedSearch, component: Preview });

type View = 'week' | 'agenda';

function Preview() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { feeds, feed, error: feedsError } = useFeeds(search.feed);
  const { publications, colorOf } = useFeedCalendars(feed);
  const [view, setView] = useState<View>('week');
  const [zone, setZone] = useState(browserZone);
  const [anchor, setAnchor] = useState(() => Temporal.Now.plainDateISO(browserZone));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const days = weekOf(anchor);
  const span = windowOf(days, zone);
  const occurrences = $api.useQuery(
    'get',
    '/api/v1/feeds/{id}/occurrences',
    { params: { path: { id: feed?.id ?? '' }, query: span } },
    { enabled: feed !== undefined, placeholderData: keepPreviousData },
  );

  const enabled = publications.filter((p) => p.enabled);
  const byId = new Map(publications.map((p) => [p.id, p]));
  const shown = (occurrences.data?.items ?? []).filter((o) => !hidden.has(o.publicationId));
  const colorOfOccurrence = (o: Occurrence) => {
    const publication = byId.get(o.publicationId);
    return o.color ?? (publication ? colorOf(publication) : null) ?? FALLBACK_COLOR;
  };
  const toggle = (id: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const error = feedsError ?? occurrences.error;
  const range = `${days[0]?.toLocaleString('en', { month: 'short', day: 'numeric' })} – ${days[6]?.toLocaleString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <>
      <PageHeader title="Preview" />
      {feed && <FeedPicker feeds={feeds} value={feed} onChange={(id) => void navigate({ search: { feed: id } })} />}
      {error && <ProblemAlert problem={toProblem(error)} className="mb-5 max-w-2xl" />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center">
          <Button size="sm" variant="ghost" aria-label="Previous week" onClick={() => setAnchor((d) => d.subtract({ weeks: 1 }))}>
            <Icon name="chevron-left" className="size-4" />
          </Button>
          <Button size="sm" onClick={() => setAnchor(Temporal.Now.plainDateISO(zone))}>
            Today
          </Button>
          <Button size="sm" variant="ghost" aria-label="Next week" onClick={() => setAnchor((d) => d.add({ weeks: 1 }))}>
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
              onClick={() => setView(v)}
              className={cx('h-7 rounded-[7px] px-3 text-[13px] font-medium capitalize', view === v ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink')}
            >
              {v}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          Time zone
          <select value={zone} onChange={(e) => setZone(e.target.value)} className="h-8 max-w-48 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink shadow-xs">
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z === browserZone ? `${z} (this browser)` : z}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Legend publications={enabled} hidden={hidden} onToggle={toggle} colorOf={(p) => colorOf(p) ?? FALLBACK_COLOR} />

      {occurrences.data?.truncated && (
        <p role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          This week has more events than the preview shows; some are left out.
        </p>
      )}

      {view === 'week' ? <WeekGrid days={days} occurrences={shown} zone={zone} colorOf={colorOfOccurrence} /> : <Agenda days={days} occurrences={shown} zone={zone} colorOf={colorOfOccurrence} />}
    </>
  );
}

/** One toggle per enabled publication, in feed order; hiding one only affects this view. */
function Legend({ publications, hidden, onToggle, colorOf }: { publications: Publication[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void; colorOf: (p: Publication) => string }) {
  if (publications.length === 0) return <p className="mb-4 text-sm text-ink-2">This feed publishes no calendars yet. Turn some on under Calendars.</p>;
  return (
    <ul aria-label="Publications" className="mb-4 flex flex-wrap gap-2">
      {publications.map((p) => {
        const on = !hidden.has(p.id);
        return (
          <li key={p.id}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(p.id)}
              className={cx('inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] shadow-xs', on ? 'border-line bg-surface text-ink' : 'border-dashed border-line-strong text-ink-3')}
            >
              <ColorChip color={colorOf(p)} className={cx('size-3', !on && 'opacity-30')} />
              {p.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
