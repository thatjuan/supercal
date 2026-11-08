import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { routeTree } from '../../routeTree.gen.ts';

const EMAIL = 'ada@example.invalid';

type Session = { data: { user: { email: string } } | null; isPending: boolean };

/** Stands in for Better Auth's session atom, which goes back to pending on the refetch a sign-up triggers. */
const session = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value: Session = { data: null, isPending: false };
  return {
    get: () => value,
    set(next: Session) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const signUpEmail = vi.hoisted(() => vi.fn());

vi.mock('../../auth.ts', () => ({
  authClient: {
    useSession: () => useSyncExternalStore(session.subscribe, session.get),
    signUp: { email: signUpEmail },
  },
}));

/** What `GET /api/v1/instance` answers, which changes once the first user exists. */
let instance: { signup: string; setupRequired: boolean };

// The app's client is same-origin, which Node's `Request` rejects, so give the hooks an absolute one.
vi.mock('../../api.ts', async (original) => {
  const { createClient, createQueryHooks } = await import('@supercal/api-client');
  return { ...(await original<object>()), $api: createQueryHooks(createClient('http://localhost', async () => Response.json(instance))) };
});

function open(path: string) {
  const queryClient = new QueryClient();
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

async function submit(button: string) {
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: EMAIL } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
  fireEvent.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(signUpEmail).toHaveBeenCalled());
}

beforeEach(() => {
  session.set({ data: null, isPending: false });
  instance = { signup: 'invite', setupRequired: true };
  vi.stubGlobal('scrollTo', () => {});
  signUpEmail.mockReset();
  signUpEmail.mockImplementation(async () => {
    session.set({ data: null, isPending: true });
    return { data: { token: null, user: {} }, error: null };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const notice = () => screen.findByRole('status');

test('the invite page keeps the notice through the session refetch a sign-up triggers', async () => {
  open('/invite/inv1');
  await submit('Create account and join');

  expect(await notice()).toHaveProperty('textContent', expect.stringContaining(EMAIL));
  act(() => session.set({ data: null, isPending: false }));
  expect(await notice()).toHaveProperty('textContent', expect.stringContaining(EMAIL));
  expect(screen.queryByRole('button', { name: 'Create account and join' })).toBeNull();
  expect(signUpEmail.mock.calls[0]?.[0]).toMatchObject({ email: EMAIL, callbackURL: '/invite/inv1' });
});

test('the invite page offers to accept once the address is confirmed elsewhere', async () => {
  open('/invite/inv1');
  await submit('Create account and join');
  await notice();

  act(() => session.set({ data: { user: { email: EMAIL } }, isPending: false }));
  expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeTruthy();
});

test('the first user keeps the notice when the install reports it is no longer empty', async () => {
  const queryClient = open('/sign-up');
  await submit('Create account');
  expect(await notice()).toHaveProperty('textContent', expect.stringContaining(EMAIL));

  instance = { signup: 'invite', setupRequired: false };
  await act(() => queryClient.invalidateQueries());

  expect(await notice()).toHaveProperty('textContent', expect.stringContaining(EMAIL));
  expect(screen.queryByRole('heading', { name: 'Sign-up is closed' })).toBeNull();
});
