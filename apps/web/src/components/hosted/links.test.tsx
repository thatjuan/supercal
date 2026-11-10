import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import type { components } from '@supercal/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stubMatchMedia } from '../../test/match-media.ts';
import { renderApp } from '../../test/render.tsx';
import { hosted, me } from './fixtures.ts';
import { LinksTab } from './links.tsx';

vi.mock('../../auth.ts', () => ({
  authClient: {
    organization: {
      getFullOrganization: () => Promise.resolve({
        data: { members: [{ userId: 'user_grace', user: { id: 'user_grace', name: 'Grace' } }] }, error: null,
      }),
    },
  },
}));

const TOKEN = 'secret-token';
const URL_HTTPS = `https://cal.example.invalid/ics/l/${TOKEN}.ics`;

type CalendarLink = components['schemas']['CalendarLink'];

const link = (overrides: Partial<CalendarLink> = {}): CalendarLink => ({ id: 'lnk_1', createdBy: 'user_1', name: 'Website', privacy: 'busy-only', expiresAt: null, createdAt: '2026-11-01T00:00:00Z', ...overrides });
const created = { ...link(), token: TOKEN, url: URL_HTTPS, webcalUrl: `webcal://cal.example.invalid/ics/l/${TOKEN}.ics`, subscribe: { google: 'https://g.example.invalid/', outlookPersonal: 'https://o.example.invalid/p', outlookWork: 'https://o.example.invalid/w' } };

async function show(items: CalendarLink[], write?: (request: Request) => Response) {
  respondWith({ '/api/v1/me': me, '/api/v1/calendars/cal_1/links': { items } }, write);
  return renderApp(<LinksTab loaded={{ calendar: hosted('cal_1'), etag: 'W/"1"' }} mine reload={() => Promise.resolve(undefined)} />);
}

beforeEach(() => {
  stubMatchMedia();
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('Create stays disabled until a privacy level is chosen, and none starts selected', async () => {
  await show([]);
  fireEvent.click(await screen.findByRole('button', { name: 'New link' }));

  const dialog = within(screen.getByRole('dialog'));
  const create = dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' });
  expect(create.disabled).toBe(true);
  expect(dialog.getAllByRole<HTMLInputElement>('radio').some((radio) => radio.checked)).toBe(false);

  fireEvent.click(dialog.getByRole('radio', { name: /Busy only/ }));
  expect(create.disabled).toBe(false);
});

test('the reveal shows both URLs once, and the token never reaches the query or mutation cache', async () => {
  const { queryClient } = await show([], () => Response.json(created, { status: 201 }));
  fireEvent.click(await screen.findByRole('button', { name: 'New link' }));
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Name (optional)'), { target: { value: 'Website' } });
  fireEvent.click(dialog.getByRole('radio', { name: /Busy only/ }));
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }));

  const reveal = within(await screen.findByRole('dialog', { name: 'Link “Website”' }));
  expect(reveal.getByLabelText<HTMLInputElement>('Subscribe URL').value).toBe(created.url);
  expect(reveal.getByLabelText<HTMLInputElement>('Calendar app URL').value).toBe(created.webcalUrl);
  expect(reveal.getByRole<HTMLAnchorElement>('link', { name: 'Add to Google Calendar' }).rel).toBe('noreferrer');
  expect(await requests('POST')[0]?.clone().json()).toEqual({ name: 'Website', privacy: 'busy-only' });

  const cached = () => JSON.stringify([queryClient.getQueryCache().getAll().map((query) => [query.queryKey, query.state.data]), queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data)]);
  expect(cached()).not.toContain(TOKEN);

  fireEvent.click(reveal.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(cached()).not.toContain(TOKEN);
  expect(screen.queryByText(new RegExp(TOKEN))).toBeNull();
});

test('a past expiry is labelled Expired, and a row has no copy action', async () => {
  await show([link({ expiresAt: '2020-01-01T00:00:00Z' }), link({ id: 'lnk_2', name: null, expiresAt: null })]);

  const expired = within(await screen.findByRole('listitem', { name: 'Website' }));
  expired.getByText('Expired');
  expect(expired.queryByRole('button', { name: /copy/i })).toBeNull();
  within(screen.getByRole('listitem', { name: 'Untitled link' })).getByText(/No expiry/);
});

test('clearing the expiry patches it to null and nothing else', async () => {
  await show([link({ expiresAt: '2099-01-01T12:00:00Z' })], () => Response.json(link()));
  fireEvent.click(within(await screen.findByRole('listitem', { name: 'Website' })).getByRole('button', { name: 'Edit' }));

  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Expires (optional)'), { target: { value: '' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(requests('PATCH')).toHaveLength(1));
  expect(await requests('PATCH')[0]?.clone().json()).toEqual({ expiresAt: null });
});

test('renaming an expired link leaves its expiry out, since the server refuses a past one', async () => {
  await show([link({ expiresAt: '2020-01-01T00:00:00Z' })], () => Response.json(link()));
  fireEvent.click(within(await screen.findByRole('listitem', { name: 'Website' })).getByRole('button', { name: 'Edit' }));

  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Name (optional)'), { target: { value: 'Blog' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(requests('PATCH')).toHaveLength(1));
  expect(await requests('PATCH')[0]?.clone().json()).toEqual({ name: 'Blog' });
});

test('each link shows its creator from the member list, including a grantee', async () => {
  await show([link({ createdBy: 'user_grace' })]);
  const row = within(await screen.findByRole('listitem', { name: 'Website' }));
  await waitFor(() => row.getByText(/Created by Grace/));
});
