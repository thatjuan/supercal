import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** The API client binds `fetch` when api.ts loads and builds same-origin relative Requests, so both are set up first. */
const fetchMock = vi.hoisted(() => {
  const NativeRequest = globalThis.Request;
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
    }
  };
  const mock = vi.fn<(request: Request) => Promise<Response>>();
  globalThis.fetch = (input: RequestInfo | URL) => mock(input instanceof Request ? input : new Request(input));
  return mock;
});

import { forgetFeedSecrets, useFeedSecrets } from '../../secrets.ts';
import { RotateCredential, type CredentialKind } from './rotate-credential.tsx';

const RESPONSES = {
  caldav: { username: 'ada-x7k2', password: 'new-app-password' },
  ics: { token: 'new-ics-token', urls: { combined: 'https://cal.example/ics/new-ics-token/all.ics', publications: [] } },
} as const;
const SECRET = { caldav: 'new-app-password', ics: 'new-ics-token' } as const;

function HeldSecrets() {
  const secrets = useFeedSecrets('feed_1');
  return <output aria-label="held">{JSON.stringify(secrets)}</output>;
}

const mount = (kind: CredentialKind) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RotateCredential feedId="feed_1" kind={kind} label="Rotate" />
      <HeldSecrets />
    </QueryClientProvider>,
  );

/** Every value written to web storage during the test. */
const stored = () => [...writes.mock.calls.map((call) => call.join('=')), ...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n');
let writes: ReturnType<typeof vi.spyOn<Storage, 'setItem'>>;

beforeEach(() => {
  writes = vi.spyOn(Storage.prototype, 'setItem');
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  forgetFeedSecrets();
  vi.restoreAllMocks();
});

describe('RotateCredential', () => {
  test.each(['caldav', 'ics'] as const)('%s: confirm, rotate, reveal once, hold in memory only', async (kind) => {
    fetchMock.mockResolvedValue(Response.json(RESPONSES[kind]));
    mount(kind);

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    const confirm = screen.getByRole('dialog');
    expect(within(confirm).getByText(/stop/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: /Rotate (password|link)/ }));

    const reveal = await screen.findByRole('dialog', { name: kind === 'caldav' ? 'New CalDAV password' : 'New ICS link' });
    const shown = within(reveal).getAllByRole<HTMLInputElement>('textbox').map((input) => input.value);
    expect(shown.join(' ')).toContain(SECRET[kind]);
    expect(within(reveal).getByText(/no longer works/)).toBeTruthy();

    const [request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.method).toBe('POST');
    expect(new URL(request?.url ?? '').pathname).toBe(`/api/v1/feeds/feed_1/credentials/${kind}/rotate`);
    expect(screen.getByRole('status', { name: 'held', hidden: true }).textContent).toContain(SECRET[kind]);
    expect(stored()).not.toContain(SECRET[kind]);

    fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('cancel rotates nothing', () => {
    mount('caldav');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failed rotation keeps the dialog open with the problem', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ type: 'about:blank', title: 'Feed not found', status: 404 }, { status: 404, headers: { 'content-type': 'application/problem+json' } }),
    );
    mount('ics');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rotate link' }));
    expect(await within(screen.getByRole('dialog')).findByText('Feed not found')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'held', hidden: true }).textContent).toBe('{}');
  });
});
