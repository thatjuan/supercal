/**
 * Every source calendar of the feed owner, grouped by account, with hosted calendars in a group of their own. The switch is the calendar's
 * passthrough publication in this feed (created on first publish when the feed has none); clicking a
 * row opens that publication's settings.
 */
import { $api } from '../../api.ts';
import { ColorChip } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { Icon } from '../ui/icon.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { Switch } from '../ui/switch.tsx';
import type { AccountGroup, CalendarRow, Feed } from './data.ts';
import { readOnlyReason, useRefreshFeeds } from './data.ts';
import { freshnessText } from './freshness.ts';
import { PrivacyBadge } from './privacy.tsx';
import { FALLBACK_COLOR } from './settings-fields.tsx';

export function CalendarList({ feed, groups, onOpen }: { feed: Feed; groups: AccountGroup[]; onOpen: (row: CalendarRow) => void }) {
  const refresh = useRefreshFeeds();
  const options = { onSettled: () => refresh() };
  const update = $api.useMutation('patch', '/api/v1/publications/{id}', options);
  const create = $api.useMutation('post', '/api/v1/feeds/{id}/publications', options);
  const error = update.error ?? create.error;

  const setPublished = ({ calendar, passthrough }: CalendarRow, enabled: boolean) => {
    if (passthrough) update.mutate({ params: { path: { id: passthrough.id } }, body: { enabled } });
    else create.mutate({ params: { path: { id: feed.id } }, body: { kind: 'passthrough', sourceCalendarId: calendar.id, enabled } });
  };

  const rows = groups.flatMap((g) => g.rows);
  const published = rows.filter((r) => r.passthrough?.enabled).length;

  return (
    <section className="rounded-[14px] border border-line bg-surface shadow-xs">
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3">
        <h2 className="text-lg font-semibold tracking-tight">Calendars ({rows.length})</h2>
        <p className="text-sm text-ink-2">
          {published} published <span aria-hidden>·</span> {rows.length - published} hidden
        </p>
      </header>
      {error && <ProblemAlert problem={toProblem(error)} className="mx-5 mb-3" />}
      {groups.length === 0 && <p className="border-t border-line px-5 py-6 text-sm text-ink-2">No calendars yet. Connect an account or create a hosted calendar.</p>}
      {groups.map((group) => (
        <AccountSection key={group.id} group={group} onOpen={onOpen} onPublish={setPublished} />
      ))}
    </section>
  );
}

function AccountSection({ group, onOpen, onPublish }: { group: AccountGroup; onOpen: (row: CalendarRow) => void; onPublish: (row: CalendarRow, on: boolean) => void }) {
  const { title, subtitle, rows } = group;
  return (
    <details open className="group mx-3 mb-2 border-t border-line">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-3 [&::-webkit-details-marker]:hidden">
        <Icon name="chevron" className="size-4 text-ink-2 transition-transform group-not-open:-rotate-90" />
        <Icon name="calendar" className="size-[18px] text-ink-2" />
        <span className="font-semibold">{title}</span>
        <span className="text-ink-3">· {subtitle}</span>
        <span className="ml-auto text-sm text-ink-2">
          {rows.length} {rows.length === 1 ? 'calendar' : 'calendars'}
        </span>
      </summary>
      <ul className="pb-1">
        {rows.map((row) => (
          <CalendarRowItem key={row.calendar.id} row={row} onOpen={onOpen} onPublish={onPublish} />
        ))}
      </ul>
    </details>
  );
}

function CalendarRowItem({ row, onOpen, onPublish }: { row: CalendarRow; onOpen: (row: CalendarRow) => void; onPublish: (row: CalendarRow, on: boolean) => void }) {
  const { calendar, passthrough, virtuals } = row;
  const on = passthrough?.enabled ?? false;
  const renamed = passthrough && passthrough.name !== calendar.name ? passthrough.name : null;
  const readOnly = readOnlyReason(row);
  const gone = calendar.state === 'gone';
  return (
    <li
      data-testid="calendar-row"
      onClick={() => passthrough && onOpen(row)}
      className={cx('grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-t border-line py-2 pr-2 pl-9 first:border-t-0 sm:grid-cols-[1fr_auto_6.5rem_9.5rem]', passthrough && 'cursor-pointer hover:bg-surface-2/60')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-2">
          <ColorChip color={passthrough?.color ?? calendar.color ?? FALLBACK_COLOR} />
          <button type="button" disabled={!passthrough} className="truncate text-left text-[15px] disabled:cursor-default" aria-label={`${calendar.name} settings`}>
            {calendar.name}
          </button>
          {readOnly && (
            <span role="img" aria-label={readOnly} title={readOnly}>
              <Icon name="lock" className="size-4 text-ink-3" />
            </span>
          )}
        </span>
        {calendar.access !== 'free-busy' && <a href={`/hosted/${encodeURIComponent(calendar.id)}`} onClick={(event) => event.stopPropagation()} className="text-sm text-accent underline focus-visible:outline active:opacity-70">Events</a>}
        {renamed && <span className="truncate text-sm text-ink-3">as “{renamed}”</span>}
        {gone && <span className="text-sm text-warning">removed at provider</span>}
        {virtuals.map((v) => (
          <span key={v.id} className="inline-flex h-6 items-center rounded-full bg-accent-soft px-2.5 text-[13px] text-accent-text">
            in: {v.name}
          </span>
        ))}
      </div>
      <Switch
        checked={on}
        aria-label={`Publish ${calendar.name}`}
        disabled={gone && !on}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={(checked) => onPublish(row, checked)}
      />
      <span className="hidden sm:block">{on && passthrough ? <PrivacyBadge privacy={passthrough.privacy} /> : <span className="pl-3 text-ink-3">—</span>}</span>
      <span className={cx('col-span-2 text-sm sm:col-span-1', calendar.freshness.stale ? 'text-warning' : 'text-ink-2')}>{calendar.kind === 'hosted' ? 'Hosted' : freshnessText(calendar.freshness)}</span>
    </li>
  );
}
