/**
 * Shared data for the Calendars and Preview screens: the selected feed (`?feed=`, else the default
 * feed), its publications, and the feed owner's accounts and calendars joined to them. Everything
 * is read through `$api`, so `useLiveUpdates` keeps it current.
 */
import type { components } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { $api, client, keyPath } from '../../api.ts';

export type Feed = components['schemas']['Feed'];
export type Account = components['schemas']['Account'];
export type Calendar = Extract<components['schemas']['Calendar'], { kind: 'connected' }>;
export type Publication = components['schemas']['Publication'];
export type VirtualPublication = Extract<Publication, { kind: 'virtual' }>;
export type Privacy = Publication['privacy'];
export type Filters = Publication['filters'];

/** Search params of screens that work on one feed. */
export type FeedSearch = { feed?: string };

/** `validateSearch` for those screens: keeps `feed` when it is a string. */
export const feedSearch = (search: Record<string, unknown>): FeedSearch => (typeof search.feed === 'string' ? { feed: search.feed } : {});

/** A source calendar in a feed: its passthrough publication (when the feed has one) and the virtual publications it feeds. */
export type CalendarRow = { calendar: Calendar; passthrough: Publication | undefined; virtuals: VirtualPublication[] };
export type AccountGroup = { account: Account; rows: CalendarRow[] };

/** The user's feeds and the one selected by `?feed=` (falling back to the default feed). */
export function useFeeds(selected: string | undefined) {
  const query = $api.useQuery('get', '/api/v1/feeds');
  const feeds = query.data?.items ?? [];
  const feed = feeds.find((f) => f.id === selected) ?? feeds.find((f) => f.isDefault) ?? feeds[0];
  return { feeds, feed, error: query.error, isPending: query.isPending };
}

const sourcesOf = (publication: Publication) =>
  publication.kind === 'passthrough' ? [publication.sourceCalendarId] : publication.sources.map((s) => s.calendarId);

/** `feedId`'s publications and the owner's calendars grouped by account, in API order. */
export function useFeedCalendars(feed: Feed | undefined) {
  const enabled = feed !== undefined;
  const publications = $api.useQuery('get', '/api/v1/feeds/{id}/publications', { params: { path: { id: feed?.id ?? '' } } }, { enabled });
  const accounts = $api.useQuery('get', '/api/v1/accounts');
  const calendars = $api.useQuery('get', '/api/v1/calendars', {}, { select: (data) => ({ items: data.items.filter((calendar) => calendar.kind === 'connected') }) });

  const items = publications.data?.items ?? [];
  const groups: AccountGroup[] = (accounts.data?.items ?? [])
    .filter((account) => account.ownerUserId === feed?.ownerUserId)
    .map((account) => ({
      account,
      rows: (calendars.data?.items ?? [])
        .filter((calendar) => calendar.accountId === account.id)
        .map((calendar) => ({
          calendar,
          passthrough: items.find((p) => p.kind === 'passthrough' && p.sourceCalendarId === calendar.id),
          virtuals: items.filter((p): p is VirtualPublication => p.kind === 'virtual' && p.sources.some((s) => s.calendarId === calendar.id)),
        })),
    }));

  const calendarById = new Map((calendars.data?.items ?? []).map((c) => [c.id, c]));
  /** A publication's colour, else its first source calendar's. */
  const colorOf = (publication: Publication) => publication.color ?? calendarById.get(sourcesOf(publication)[0] ?? '')?.color ?? null;

  return {
    publications: items,
    groups,
    calendars: calendarById,
    colorOf,
    error: publications.error ?? accounts.error ?? calendars.error,
    isPending: !enabled || publications.isPending || accounts.isPending || calendars.isPending,
  };
}

/** Refetches every feed and publication query after a write (the stream also does this, a moment later). */
export function useRefreshFeeds() {
  const client = useQueryClient();
  return () =>
    client.invalidateQueries({
      predicate: (query) => {
        const path = keyPath(query.queryKey);
        return path.startsWith('/api/v1/feeds') || path.startsWith('/api/v1/publications') || path.startsWith('/api/v1/calendars');
      },
    });
}

/** Turns off the passthrough publications of `calendarIds` in a feed ("also hide the individual calendars"). */
export async function hidePassthroughs(publications: Publication[], calendarIds: readonly string[]) {
  const targets = publications.filter((p) => p.kind === 'passthrough' && p.enabled && calendarIds.includes(p.sourceCalendarId));
  for (const target of targets) {
    const { error } = await client.PATCH('/api/v1/publications/{id}', { params: { path: { id: target.id } }, body: { enabled: false } });
    if (error) throw error;
  }
}
