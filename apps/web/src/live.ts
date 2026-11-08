/**
 * Live updates from `GET /api/v1/stream`. `useLiveUpdates` is mounted once, in the signed-in shell,
 * and turns each server-sent event into React Query invalidations, so screens only need `$api`
 * queries to stay current.
 *
 * The browser reconnects on its own and resends `Last-Event-ID`. When it gives up (the stream
 * answered with an error status), the hook reopens after `RETRY_MS` and passes the last seen id as
 * `?lastEventId=`. Only `resources.changed` is replayable, so after any interruption the account and
 * feed queries are refreshed too.
 */
import type { components } from '@supercal/api-client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { keyPath } from './api.ts';

export type StreamEvent = components['schemas']['StreamEvent'];
type EventType = StreamEvent['type'];
type EventOf<T extends EventType> = Extract<StreamEvent, { type: T }>;
type Account = components['schemas']['Account'];

/** `connecting` until the first open; `reconnecting` after an error until the stream is open again. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

export const STREAM_URL = '/api/v1/stream';
export const RETRY_MS = 5_000;

const isAccounts = (path: string) => path.startsWith('/api/v1/accounts');
const isFeeds = (path: string) => path.startsWith('/api/v1/feeds') || path.startsWith('/api/v1/publications');
const isResources = (path: string) => path.endsWith('/occurrences') || path.startsWith('/api/v1/calendars') || isAccounts(path);

const invalidate = (client: QueryClient, match: (path: string) => boolean) =>
  client.invalidateQueries({ predicate: (query) => match(keyPath(query.queryKey)) });

/** `value` (one account, or a page of them) with the account `event` names given its new status. */
function withAccountStatus(value: unknown, event: EventOf<'account.status'>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if ('items' in value && Array.isArray(value.items)) return { ...value, items: value.items.map((item: unknown) => withAccountStatus(item, event)) };
  if ('id' in value && value.id === event.accountId) {
    return { ...value, ...({ status: event.status, statusDetail: event.detail ?? null } satisfies Partial<Account>) };
  }
  return value;
}

/** What each event does to the cache. Typed per event, so a new event type fails the build until handled. */
const handlers: { [T in EventType]: (client: QueryClient, event: EventOf<T>) => unknown } = {
  'resources.changed': (client) => invalidate(client, isResources),
  'account.status': (client, event) =>
    client.setQueriesData({ predicate: (query) => isAccounts(keyPath(query.queryKey)) }, (value: unknown) => withAccountStatus(value, event)),
  'feed.changed': (client) => invalidate(client, isFeeds),
  reset: (client) => client.invalidateQueries(),
};

const EVENT_TYPES = Object.keys(handlers) as EventType[];

const isEvent =<T extends EventType>(value: unknown, type: T): value is EventOf<T> =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === type;

function listen<T extends EventType>(source: EventSource, type: T, onEvent: (event: EventOf<T>, id: string) => void) {
  source.addEventListener(type, (message: MessageEvent<string>) => {
    const event: unknown = JSON.parse(message.data);
    if (isEvent(event, type)) onEvent(event, message.lastEventId);
  });
}

/**
 * Subscribes to the live stream while mounted and returns its status for the shell's indicator.
 * `scope` (the active tenant id) reopens the stream when it changes, since a stream serves one tenant.
 */
export function useLiveUpdates(scope: string | undefined): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (scope === undefined) return;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastEventId = '';
    let interrupted = false;
    setStatus('connecting');

    const open = () => {
      const stream = new EventSource(lastEventId ? `${STREAM_URL}?lastEventId=${encodeURIComponent(lastEventId)}` : STREAM_URL);
      source = stream;
      stream.onopen = () => {
        setStatus('live');
        if (interrupted) {
          interrupted = false;
          void invalidate(client, (path) => isAccounts(path) || isFeeds(path));
        }
      };
      stream.onerror = () => {
        interrupted = true;
        setStatus('reconnecting');
        if (stream.readyState === EventSource.CLOSED) retry = setTimeout(open, RETRY_MS);
      };
      const subscribe = <T extends EventType>(type: T) =>
        listen(stream, type, (event, id) => {
          if (id) lastEventId = id;
          handlers[type](client, event);
        });
      EVENT_TYPES.forEach(subscribe);
    };

    open();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [client, scope]);

  return status;
}
