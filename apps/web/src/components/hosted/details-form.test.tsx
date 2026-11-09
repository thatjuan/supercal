import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import type { Access, LoadedCalendar } from './data.ts';
import { DetailsForm } from './details-form.tsx';
import { hosted } from './fixtures.ts';

const ETAG = 'W/"cal_1.1"';
const loaded = (access: Access = 'manage'): LoadedCalendar => ({ calendar: hosted('cal_1', { name: 'Team', description: 'Old notes', timezone: 'UTC', access }), etag: ETAG });

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const name = () => screen.getByLabelText<HTMLInputElement>('Name');
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

test('sends only the changed fields, with If-Match', async () => {
  const updated = hosted('cal_1', { name: 'Team B', description: 'Old notes', access: 'manage' });
  respondWith({}, () => Response.json(updated, { headers: { etag: 'W/"cal_1.2"' } }));
  await renderApp(<DetailsForm loaded={loaded()} reload={() => Promise.resolve(undefined)} />);

  fireEvent.change(name(), { target: { value: 'Team B' } });
  save();

  await screen.findByText('Saved');
  const [request] = requests('PATCH');
  expect(request?.headers.get('if-match')).toBe(ETAG);
  expect(await request?.clone().json()).toEqual({ name: 'Team B' });
});

test('on 412 it keeps what was typed and offers Reload, which brings the newest version', async () => {
  respondWith({}, () => Response.json({ type: 'about:blank', title: 'Precondition failed', status: 412 }, { status: 412, headers: { 'content-type': 'application/problem+json' } }));
  const newest = { calendar: hosted('cal_1', { name: 'Renamed elsewhere', access: 'manage' }), etag: 'W/"cal_1.3"' };
  const reload = vi.fn(() => Promise.resolve(newest));
  await renderApp(<DetailsForm loaded={loaded()} reload={reload} />);

  fireEvent.change(name(), { target: { value: 'My typing' } });
  save();

  expect((await screen.findByRole('alert')).textContent).toContain('This calendar changed elsewhere');
  expect(name().value).toBe('My typing');

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(name().value).toBe('Renamed elsewhere'));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an untouched form follows a newer copy; one with unsaved typing keeps the typing', async () => {
  respondWith({});
  const noReload = () => Promise.resolve(undefined);
  const newer = (at: string, calendarName: string) => ({ calendar: hosted('cal_1', { name: calendarName, access: 'manage', updatedAt: at }), etag: `W/"${at}"` });
  const queries = new QueryClient();
  const form = (next: LoadedCalendar) => (
    <QueryClientProvider client={queries}>
      <DetailsForm loaded={next} reload={noReload} />
    </QueryClientProvider>
  );
  const { rerender } = render(form(loaded()));

  rerender(form(newer('2026-11-09T00:00:00Z', 'Live')));
  expect(name().value).toBe('Live');

  fireEvent.change(name(), { target: { value: 'My typing' } });
  rerender(form(newer('2026-11-10T00:00:00Z', 'Later')));
  expect(name().value).toBe('My typing');
});

test.each<Access>(['read', 'write'])('is read-only at %s', async (access) => {
  respondWith({});
  await renderApp(<DetailsForm loaded={loaded(access)} reload={() => Promise.resolve(undefined)} />);
  expect(screen.getByText('Team')).toBeTruthy();
  expect(screen.getByText('Old notes')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});
