import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DeviceLoginSettings } from './device-logins.tsx';

const PASSWORD = 'one-time-password';
const created = { id: 'dvl_1', name: 'Work iPhone', username: 'ada-x7k2', password: PASSWORD, serverUrl: 'https://cal.example/dav/', createdAt: '2026-11-08T00:00:00Z' };
const listed = { id: 'dvl_1', name: 'Work iPhone', username: 'ada-x7k2', lastUsedAt: null, createdAt: '2026-11-08T00:00:00Z' };

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Suspense>
        <DeviceLoginSettings />
      </Suspense>
    </QueryClientProvider>,
  );

const createDevice = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'New device' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work iPhone' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create login' }));
};

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(cleanup);

test('the reveal shows the three values, once', async () => {
  let items: unknown[] = [];
  fetchMock.mockImplementation(async (request) => {
    if (request.method === 'GET') return Response.json({ items });
    items = [listed];
    return Response.json(created, { status: 201 });
  });
  mount();
  await createDevice();

  expect((await screen.findByLabelText<HTMLInputElement>('Server URL')).value).toBe(created.serverUrl);
  expect(screen.getByLabelText<HTMLInputElement>('Username').value).toBe(created.username);
  expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe(PASSWORD);
  expect(screen.getByText('Thunderbird:')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByLabelText('Password')).toBeNull());
  expect(screen.getByRole('listitem', { name: 'Work iPhone' }).textContent).toContain('Never used');
  expect(document.body.innerHTML).not.toContain(PASSWORD);
});

test('the quota problem shows in the dialog', async () => {
  respondWith({ '/api/v1/dav-logins': { items: [] } }, () =>
    Response.json({ type: 'https://supercal.dev/problems/dav-login-quota', title: 'DAV login quota exceeded', status: 409 }, { status: 409, headers: { 'content-type': 'application/problem+json' } }),
  );
  mount();
  await createDevice();
  expect((await screen.findByRole('alert')).textContent).toContain('DAV login quota exceeded');
});

test('revoking confirms first, then deletes that login', async () => {
  respondWith({ '/api/v1/dav-logins': { items: [{ ...listed, lastUsedAt: '2026-11-01T12:00:00Z' }] } });
  mount();
  expect((await screen.findByRole('listitem', { name: 'Work iPhone' })).textContent).toContain('Last used Nov 1, 2026');

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(requests('DELETE')).toHaveLength(0);
  expect(screen.getByText(/stops syncing at once/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke login' }));

  await waitFor(() => expect(requests('DELETE')).toHaveLength(1));
  expect(new URL(requests('DELETE')[0]?.url ?? '').pathname).toBe('/api/v1/dav-logins/dvl_1');
});
