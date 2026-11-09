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
import { browserZone } from '../../lib/zones.ts';
import { feedSearch, useFeedCalendars, useFeeds, type Publication } from '../../components/calendars/data.ts';
import { FeedPicker } from '../../components/calendars/feed-picker.tsx';
import { FALLBACK_COLOR } from '../../components/calendars/settings-fields.tsx';
import { PageHeader } from '../../components/page-header.tsx';
import { Agenda } from '../../components/preview/agenda.tsx';
import { weekOf, windowOf, type Occurrence } from '../../components/preview/layout.ts';
import { WeekControls, type View } from '../../components/preview/week-controls.tsx';
import { WeekGrid } from '../../components/preview/week-grid.tsx';
import { ColorChip } from '../../components/ui/calendar-color.tsx';
import { cx } from '../../components/ui/cx.ts';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/preview')({ validateSearch: feedSearch, component: Preview });

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
  const shown = (occurrences.data?.items ?? [])
    .filter((o) => !hidden.has(o.publicationId))
    .map((o) => ({ ...o, key: `${o.publicationId}/${o.outputUid}/${o.recurrenceId}`, title: o.summary }));
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

  return (
    <>
      <PageHeader title="Preview" />
      {feed && <FeedPicker feeds={feeds} value={feed} onChange={(id) => void navigate({ search: { feed: id } })} />}
      {error && <ProblemAlert problem={toProblem(error)} className="mb-5 max-w-2xl" />}

      <WeekControls days={days} view={view} onView={setView} zone={zone} onZone={setZone} onAnchor={setAnchor} />

      <Legend publications={enabled} hidden={hidden} onToggle={toggle} colorOf={(p) => colorOf(p) ?? FALLBACK_COLOR} />

      {occurrences.data?.truncated && (
        <p role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          This week has more events than the preview shows; some are left out.
        </p>
      )}

      {view === 'week' ? <WeekGrid days={days} items={shown} zone={zone} colorOf={colorOfOccurrence} /> : <Agenda days={days} items={shown} zone={zone} colorOf={colorOfOccurrence} />}
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
