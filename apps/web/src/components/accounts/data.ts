/**
 * Account data for the onboarding and accounts screens, all through `$api`: the queries, the
 * optimistic account and publication toggles, and the OAuth hand-off. The live stream keeps the
 * queries current (`resources.changed` and `account.status` touch every `/accounts` and
 * `/calendars` key).
 */
import type { components } from '@supercal/api-client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { consentUrl } from '../subscribe/sinks.ts';
import { $api, keyPath } from '../../api.ts';
import type { Account, Calendar } from './health.ts';
import type { OAuthProvider } from './providers.tsx';

type AccountList = components['schemas']['AccountList'];
type PublicationList = components['schemas']['PublicationList'];

export const accountsQuery = $api.queryOptions('get', '/api/v1/accounts');
export const calendarsQuery = $api.queryOptions('get', '/api/v1/calendars', {}, { select: (data) => ({ items: data.items.filter((calendar) => calendar.kind === 'connected') }) });
export const instanceQuery = $api.queryOptions('get', '/api/v1/instance');

/** Refetches every account and calendar query, after a connect, reconnect or removal. */
export const refreshAccounts = (client: QueryClient) =>
  client.invalidateQueries({ predicate: ({ queryKey }) => /^\/api\/v1\/(accounts|calendars|feeds|publications)/.test(keyPath(queryKey)) });

/** Calendars grouped by account id. */
export function calendarsByAccount(calendars: readonly Calendar[] | undefined): Map<string, Calendar[]> {
  const groups = new Map<string, Calendar[]>();
  for (const calendar of calendars ?? []) if (calendar.accountId) groups.set(calendar.accountId, [...(groups.get(calendar.accountId) ?? []), calendar]);
  return groups;
}

/**
 * `PATCH /accounts/{id}` (rename, auto-publish), applied to the list at once and rolled back when
 * the API answers with a problem, which goes to `onProblem`.
 */
export function useUpdateAccount(onProblem: (error: unknown) => void) {
  const client = useQueryClient();
  const { queryKey } = accountsQuery;
  return $api.useMutation('patch', '/api/v1/accounts/{id}', {
    onMutate: async ({ params, body }) => {
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<AccountList>(queryKey);
      const patch: Partial<Account> = { ...(body.displayName !== undefined && { displayName: body.displayName }), ...(body.autoPublish !== undefined && { autoPublish: body.autoPublish }) };
      client.setQueryData<AccountList>(queryKey, (list) => list && { ...list, items: list.items.map((account) => (account.id === params.path.id ? { ...account, ...patch } : account)) });
      return { previous };
    },
    onError: (error, _variables, context) => {
      client.setQueryData<AccountList>(queryKey, context?.previous);
      onProblem(error);
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
}

/** The user's default feed and its publications, for publish toggles (`enabled` per calendar). */
export function useDefaultPublications() {
  const feeds = $api.useQuery('get', '/api/v1/feeds');
  const feedId = feeds.data?.items.find((feed) => feed.isDefault)?.id ?? '';
  return $api.useQuery('get', '/api/v1/feeds/{id}/publications', { params: { path: { id: feedId } } }, { enabled: feedId !== '' });
}

/** `PATCH /publications/{id}` `{ enabled }`, applied to the default feed's list at once and rolled back on a problem. */
export function useTogglePublication(onProblem: (error: unknown) => void) {
  const client = useQueryClient();
  const isList = ({ queryKey }: { queryKey: readonly unknown[] }) => keyPath(queryKey) === '/api/v1/feeds/{id}/publications';
  return $api.useMutation('patch', '/api/v1/publications/{id}', {
    onMutate: async ({ params, body }) => {
      await client.cancelQueries({ predicate: isList });
      const previous = client.getQueriesData<PublicationList>({ predicate: isList });
      client.setQueriesData<PublicationList>(
        { predicate: isList },
        (list) => list && { ...list, items: list.items.map((item) => (item.id === params.path.id && body.enabled !== undefined ? { ...item, enabled: body.enabled } : item)) },
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      for (const [key, data] of context?.previous ?? []) client.setQueryData(key, data);
      onProblem(error);
    },
    onSettled: () => client.invalidateQueries({ predicate: isList }),
  });
}

/**
 * Starts an OAuth connect (or reconnect, with `accountId`) and sends the browser to the consent
 * screen; the callback returns to `returnTo` with `accountId` or `error` added.
 */
export function useOAuth(onProblem: (error: unknown) => void) {
  const options = { onSuccess: ({ authorizationUrl }: { authorizationUrl: string }) => window.location.assign(authorizationUrl), onError: onProblem };
  const google = $api.useMutation('post', '/api/v1/accounts/oauth/google/start', options);
  const microsoft = $api.useMutation('post', '/api/v1/accounts/oauth/microsoft/start', options);
  const reconnect = $api.useMutation('post', '/api/v1/accounts/{id}/reconnect', options);
  return {
    pending: google.isPending || microsoft.isPending || reconnect.isPending,
    connect: (provider: OAuthProvider, returnTo: string) => ({ google, microsoft })[provider].mutate({ body: { returnTo } }),
    reconnect: (accountId: string, returnTo: string) => reconnect.mutate({ params: { path: { id: accountId } }, body: { returnTo } }),
  };
}

/** Providers whose account-level editing consent is implemented by the API. */
export const EDITING_CONSENT_PROVIDERS: ReadonlySet<Account['provider']> = new Set(['google', 'microsoft']);

/** Start incremental consent, or refresh the account when consent was already granted. */
export function useAllowEditing(onProblem: (error: unknown) => void) {
  const client = useQueryClient();
  return $api.useMutation('post', '/api/v1/accounts/{id}/allow-editing', {
    onSuccess: () => refreshAccounts(client),
    onError: (error) => {
      const url = consentUrl(error);
      if (url) window.location.assign(url);
      else onProblem(error);
    },
  });
}
