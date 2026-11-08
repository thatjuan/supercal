/**
 * The Calendars screen's side column: the feed's virtual calendars, the publication order (which
 * sets `calendar-order` in CalDAV clients and precedence in the combined ICS), and a privacy key.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { $api } from '../../api.ts';
import { ColorChip } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { Icon } from '../ui/icon.tsx';
import { Switch } from '../ui/switch.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { useRefreshFeeds, type Calendar, type Feed, type Publication, type VirtualPublication } from './data.ts';
import { PRIVACY, PrivacyBadge } from './privacy.tsx';
import { FALLBACK_COLOR } from './settings-fields.tsx';
import { SortableList } from './sortable-list.tsx';

const card = 'rounded-[14px] border border-line bg-surface px-5 py-4 shadow-xs';

export function VirtualCalendars({ feed, publications, calendars }: { feed: Feed; publications: Publication[]; calendars: Map<string, Calendar> }) {
  const virtuals = publications.filter((p): p is VirtualPublication => p.kind === 'virtual');
  const refresh = useRefreshFeeds();
  const update = $api.useMutation('patch', '/api/v1/publications/{id}', { onSettled: () => refresh() });
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold tracking-tight">Virtual calendars</h2>
      <p className="text-sm text-ink-2">Combine several calendars into one.</p>
      {update.error && <ProblemAlert problem={toProblem(update.error)} className="mt-3" />}
      <ul className="mt-3 grid gap-2">
        {virtuals.map((v) => (
          <li key={v.id} className="flex items-center gap-3 rounded-[10px] border border-line pr-3 hover:bg-surface-2">
            <Link
              to="/calendars/virtual/$publicationId"
              params={{ publicationId: v.id }}
              search={{ feed: feed.id }}
              className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3"
            >
              <Icon name="layers" className="text-ink-2" />
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate font-semibold', !v.enabled && 'text-ink-3')}>{v.name}</span>
                <span className="block truncate text-[13px] text-ink-2">{v.sources.map((s) => calendars.get(s.calendarId)?.name ?? 'Unknown').join(', ')}</span>
              </span>
              {v.status === 'disabled-invalid' ? <span className="text-[13px] text-warning">needs attention</span> : v.enabled && <PrivacyBadge privacy={v.privacy} />}
            </Link>
            <Switch
              checked={v.enabled}
              aria-label={`Publish ${v.name}`}
              onCheckedChange={(enabled) => update.mutate({ params: { path: { id: v.id } }, body: { enabled } })}
            />
          </li>
        ))}
      </ul>
      <Link
        to="/calendars/virtual/new"
        search={{ feed: feed.id }}
        className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-[9px] border border-line bg-surface px-4 text-[15px] font-medium shadow-xs hover:bg-surface-2"
      >
        <Icon name="plus" className="size-4" />
        New virtual calendar
      </Link>
    </section>
  );
}

export function PublicationOrder({ feed, publications, colorOf }: { feed: Feed; publications: Publication[]; colorOf: (p: Publication) => string | null }) {
  const queryClient = useQueryClient();
  const listKey = $api.queryOptions('get', '/api/v1/feeds/{id}/publications', { params: { path: { id: feed.id } } }).queryKey;
  const reorder = $api.useMutation('put', '/api/v1/feeds/{id}/publications/order', { onSuccess: (list) => queryClient.setQueryData(listKey, list) });
  // While a reorder is in flight, show the order it sends.
  const shown = reorder.isPending && reorder.variables ? reorder.variables.body.ids.flatMap((id) => publications.filter((p) => p.id === id)) : publications;

  return (
    <section className={card}>
      <h2 className="text-lg font-semibold tracking-tight">Order</h2>
      <p className="text-sm text-ink-2">The order calendar apps list these in. The first wins when the combined calendar has the same event twice.</p>
      {reorder.error && <ProblemAlert problem={toProblem(reorder.error)} className="mt-3" />}
      {shown.length > 0 ? (
        <SortableList
          label="Publication order"
          items={shown}
          keyOf={(p) => p.id}
          labelOf={(p) => p.name}
          onReorder={(next) => reorder.mutate({ params: { path: { id: feed.id } }, body: { ids: next.map((p) => p.id) } })}
          className="mt-3"
        >
          {(p) => (
            <span className={cx('flex min-w-0 items-center gap-2 text-sm', !p.enabled && 'text-ink-3')}>
              <ColorChip color={colorOf(p) ?? FALLBACK_COLOR} className="size-3.5" />
              <span className="truncate">{p.name}</span>
              {p.kind === 'virtual' && <Icon name="layers" className="size-3.5 text-ink-3" />}
              {!p.enabled && <span className="ml-auto text-[13px]">hidden</span>}
            </span>
          )}
        </SortableList>
      ) : (
        <p className="mt-3 text-sm text-ink-3">Nothing published yet.</p>
      )}
    </section>
  );
}

export function PrivacyKey() {
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold tracking-tight">Privacy levels</h2>
      <p className="text-sm text-ink-2">How much event detail each calendar publishes.</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-sm">
        {(Object.keys(PRIVACY) as (keyof typeof PRIVACY)[]).map((level) => (
          <div key={level} className="contents">
            <dt>
              <PrivacyBadge privacy={level} />
            </dt>
            <dd className="text-ink-2">{PRIVACY[level].explanation}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
