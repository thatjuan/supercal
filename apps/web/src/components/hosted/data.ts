/** Calendar data for the detail and Hosted screens: access levels, the list's sections, loading one calendar with its ETag, and restoring. */
import type { components } from '@supercal/api-client';
import { useQuery } from '@tanstack/react-query';
import { $api, client, isProblem, meQuery } from '../../api.ts';
import { useToast } from '../accounts/toast.tsx';
import { useRefreshFeeds } from '../calendars/data.ts';
import { toProblem } from '../ui/problem-alert.tsx';

/** A hosted or connected calendar that can be opened in the event and sharing tabs. */
export type Calendar = components['schemas']['Calendar'];
export type HostedCalendar = Extract<components['schemas']['Calendar'], { kind: 'hosted' }>;
export type Access = HostedCalendar['access'];

const LEVELS = ['free-busy', 'read', 'write', 'manage', 'owner'] as const satisfies readonly Access[];
/** Mirrors `atLeast` in apps/daemon/src/hosted/access.ts. The server still enforces every check. */
export const atLeast = (access: Access, min: Access) => LEVELS.indexOf(access) >= LEVELS.indexOf(min);

/** A calendar as the detail page loaded it: with the ETag saving needs. */
export type LoadedCalendar = { calendar: Calendar; etag: string };

/** What every tab of the detail page receives. `reload` refetches and returns the newest version. */
export type CalendarTabProps = { loaded: LoadedCalendar; mine: boolean; reload: () => Promise<LoadedCalendar | null | undefined> };

/** How a deleted calendar comes back; said whenever one is deleted or restored. */
export const RESTORE_NOTE = 'Restoring does not turn its feed publications back on or add it to virtual calendars again.';

/**
 * The three sections of the list. A tenant admin's `access` is `owner` on every calendar in the
 * tenant, so being the owner is read from `owner.id`, never from `access`.
 */
export function partitionHosted(items: readonly components['schemas']['Calendar'][], userId: string) {
  const hosted = items.filter((calendar): calendar is HostedCalendar => calendar.kind === 'hosted');
  const owned = hosted.filter((calendar) => calendar.owner.id === userId);
  return {
    mine: owned.filter((calendar) => calendar.state === 'active').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)),
    deleted: owned.filter((calendar) => calendar.state === 'gone'),
    others: hosted
      .filter((calendar) => calendar.owner.id !== userId && (calendar.state === 'active' || atLeast(calendar.access, 'owner')))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Splits `GET /api/v1/calendars` into the three sections of the list. */
export function useHostedCalendars(): { mine: HostedCalendar[]; others: HostedCalendar[]; deleted: HostedCalendar[]; error: unknown; isPending: boolean } {
  const me = useQuery(meQuery);
  const calendars = $api.useQuery('get', '/api/v1/calendars');
  return {
    ...partitionHosted(calendars.data?.items ?? [], me.data?.user.id ?? ''),
    error: me.error ?? calendars.error,
    isPending: me.isPending || calendars.isPending,
  };
}

/** The key's second part is the API path, so the live stream and `useRefreshFeeds` refresh it along with the other calendar queries. */
export const hostedCalendarKey = (id: string) => ['hosted-calendar', '/api/v1/calendars/{id}', id];

/** One hosted or connected calendar with its ETag, which `$api` hides. */
export function useHostedCalendar(id: string) {
  return useQuery({
    queryKey: hostedCalendarKey(id),
    queryFn: async (): Promise<LoadedCalendar | null> => {
      const { data, error, response } = await client.GET('/api/v1/calendars/{id}', { params: { path: { id } } });
      if (error) throw error;
      return { calendar: data, etag: response.headers.get('etag') ?? '' };
    },
  });
}

/** Restores a deleted calendar and says what stays off. A 409 means it is no longer deleted, so the refetch is all it needs. */
export function useRestoreCalendar() {
  const toast = useToast();
  const refresh = useRefreshFeeds();
  const restore = $api.useMutation('post', '/api/v1/calendars/{id}/restore', {
    onSuccess: (calendar) => toast({ tone: 'success', message: `Restored “${calendar.name}”. Its feed publications stay off, and any virtual calendars need it added again.` }),
    onError: (error) => {
      if (!(isProblem(error) && error.status === 409)) toast({ tone: 'error', message: toProblem(error).detail ?? toProblem(error).title });
    },
    onSettled: () => refresh(),
  });
  return { restore: (id: string) => restore.mutate({ params: { path: { id } } }), isPending: restore.isPending };
}
