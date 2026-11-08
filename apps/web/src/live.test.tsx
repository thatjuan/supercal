import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LiveIndicator } from './components/ui/live-indicator.tsx';
import { RETRY_MS, STREAM_URL, useLiveUpdates, type StreamEvent } from './live.ts';

/** A scriptable stand-in for the browser's EventSource. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
  emit(event: StreamEvent, id = '') {
    this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: id }));
  }
}

const latest = () => {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error('no EventSource was opened');
  return source;
};

const KEYS = {
  occurrences: ['get', '/api/v1/feeds/{id}/occurrences', { params: { path: { id: 'feed_1' } } }],
  calendars: ['get', '/api/v1/calendars'],
  accounts: ['get', '/api/v1/accounts'],
  feeds: ['get', '/api/v1/feeds'],
  publication: ['get', '/api/v1/publications/{id}', { params: { path: { id: 'pub_1' } } }],
  me: ['get', '/api/v1/me'],
} as const;
type Name = keyof typeof KEYS;

let client: QueryClient;

function Probe() {
  return <LiveIndicator status={useLiveUpdates('tenant_1')} />;
}

const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );

const invalidated = () =>
  (Object.keys(KEYS) as Name[]).filter((name) => client.getQueryState(KEYS[name])?.isInvalidated).sort();

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  client = new QueryClient();
  for (const key of Object.values(KEYS)) client.setQueryData(key, { items: [] });
  client.setQueryData(KEYS.accounts, { items: [{ id: 'acc_1', status: 'active', statusDetail: null }, { id: 'acc_2', status: 'active', statusDetail: null }] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveUpdates', () => {
  test('opens one stream and invalidates by event type', () => {
    mount();
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([STREAM_URL]);
    act(() => latest().open());

    act(() => latest().emit({ type: 'resources.changed', seq: '7', calendarIds: ['cal_1'] }, '7'));
    expect(invalidated()).toEqual(['accounts', 'calendars', 'occurrences']);

    client.resetQueries();
    for (const key of Object.values(KEYS)) client.setQueryData(key, { items: [] });
    act(() => latest().emit({ type: 'feed.changed', feedId: 'feed_1' }));
    // Occurrences sit under /feeds/{id}, so a feed change refreshes the preview too.
    expect(invalidated()).toEqual(['feeds', 'occurrences', 'publication']);

    act(() => latest().emit({ type: 'reset' }));
    expect(invalidated()).toEqual(['accounts', 'calendars', 'feeds', 'me', 'occurrences', 'publication']);
  });

  test('account.status updates that account in the cache without a refetch', () => {
    mount();
    act(() => latest().open());
    act(() => latest().emit({ type: 'account.status', accountId: 'acc_2', status: 'reauth_required', detail: 'Token expired' }));
    expect(client.getQueryData(KEYS.accounts)).toEqual({
      items: [
        { id: 'acc_1', status: 'active', statusDetail: null },
        { id: 'acc_2', status: 'reauth_required', statusDetail: 'Token expired' },
      ],
    });
    expect(client.getQueryState(KEYS.accounts)?.isInvalidated).toBe(false);
  });

  test('shows Reconnecting… after an error, then Live once the stream reopens', () => {
    mount();
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
    act(() => latest().open());
    expect(screen.getByRole('status').textContent).toBe('Live');

    act(() => latest().fail(FakeEventSource.CONNECTING));
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
    act(() => latest().open());
    expect(screen.getByRole('status').textContent).toBe('Live');
    // account.status and feed.changed are not replayed, so an interruption refreshes them.
    expect(invalidated()).toEqual(['accounts', 'feeds', 'occurrences', 'publication']);
  });

  test('when the browser gives up, reopens later from the last event id', () => {
    mount();
    act(() => latest().open());
    act(() => latest().emit({ type: 'resources.changed', seq: '41', calendarIds: ['cal_1'] }, '41'));
    act(() => latest().fail(FakeEventSource.CLOSED));
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(RETRY_MS));
    expect(latest().url).toBe(`${STREAM_URL}?lastEventId=41`);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
  });

  test('closes the stream on unmount', () => {
    const { unmount } = mount();
    const source = latest();
    unmount();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
});
