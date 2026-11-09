import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { partitionHosted } from './data.ts';
import { freeBusy, hosted, me, ME_ID } from './fixtures.ts';
import { HostedList } from './hosted-list.tsx';

const COLLEAGUE = { id: 'user_grace', name: 'Grace' };

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const names = (calendars: { name: string }[]) => calendars.map((calendar) => calendar.name);

test('partition: ownership decides the section, not an admin’s owner access', () => {
  const { mine, others, deleted } = partitionHosted(
    [
      hosted('B', { sortOrder: 1 }),
      hosted('Z', { sortOrder: 0 }),
      hosted('A', { sortOrder: 1 }),
      hosted('Mine, deleted', { state: 'gone' }),
      hosted('Colleague', { access: 'owner', owner: COLLEAGUE }),
      hosted('Colleague, deleted, admin', { access: 'owner', state: 'gone', owner: COLLEAGUE }),
      hosted('Colleague, deleted, manager', { access: 'manage', state: 'gone', owner: COLLEAGUE }),
      hosted('Awake', { access: 'read', owner: COLLEAGUE }),
    ],
    ME_ID,
  );
  expect(names(mine)).toEqual(['Z', 'A', 'B']);
  expect(names(deleted)).toEqual(['Mine, deleted']);
  expect(names(others)).toEqual(['Awake', 'Colleague', 'Colleague, deleted, admin']);
});

test('a free-busy calendar, with its optional fields absent, lists its owner and access', async () => {
  respondWith({ '/api/v1/me': me, '/api/v1/calendars': { items: [freeBusy('Grace’s week', 'Grace')] } });
  await renderApp(<HostedList onCreate={() => {}} />);
  const shared = await screen.findByRole('region', { name: 'Shared with you' });
  expect(within(shared).getByText('Grace’s week')).toBeTruthy();
  expect(within(shared).getByText('Grace')).toBeTruthy();
  expect(within(shared).getByText('Free/busy')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Deleted' })).toBeNull();
});

test('empty sections are omitted, and no calendars of your own explains what one is', async () => {
  respondWith({ '/api/v1/me': me, '/api/v1/calendars': { items: [] } });
  const onCreate = vi.fn();
  await renderApp(<HostedList onCreate={onCreate} />);
  expect(await screen.findByText(/keeps its events in Supercal/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Shared with you' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New calendar' }));
  expect(onCreate).toHaveBeenCalled();
});

test('a deleted calendar shows when it goes for good', async () => {
  respondWith({ '/api/v1/me': me, '/api/v1/calendars': { items: [hosted('Old', { state: 'gone', goneAt: '2026-11-01T12:00:00Z' })] } });
  await renderApp(<HostedList onCreate={() => {}} />);
  expect((await screen.findByRole('listitem', { name: 'Old' })).textContent).toContain('Deleted permanently on Dec 1, 2026');
});

test('reordering sends a PATCH only for rows whose sortOrder changed, then refetches', async () => {
  const items = [hosted('One', { sortOrder: 0 }), hosted('Two', { sortOrder: 1 }), hosted('Three', { sortOrder: 2 }), hosted('Four', { sortOrder: 3 })];
  respondWith({ '/api/v1/me': me, '/api/v1/calendars': { items } }, () => Response.json(items[0]));
  await renderApp(<HostedList onCreate={() => {}} />);
  const before = requests('GET').length;

  fireEvent.keyDown(await screen.findByRole('button', { name: 'Move Two' }), { key: 'ArrowDown' });

  await waitFor(() => expect(requests('GET').length).toBeGreaterThan(before));
  const sent = await Promise.all(requests('PATCH').map(async (request) => [new URL(request.url).pathname, await request.clone().json()]));
  expect(sent).toEqual([
    ['/api/v1/calendars/Three', { sortOrder: 1 }],
    ['/api/v1/calendars/Two', { sortOrder: 2 }],
  ]);
});

test('a failed reorder stops, says why and refetches', async () => {
  const items = [hosted('One', { sortOrder: 0 }), hosted('Two', { sortOrder: 1 })];
  respondWith({ '/api/v1/me': me, '/api/v1/calendars': { items } }, () =>
    Response.json({ type: 'about:blank', title: 'Nope', status: 403 }, { status: 403, headers: { 'content-type': 'application/problem+json' } }),
  );
  await renderApp(<HostedList onCreate={() => {}} />);
  const before = requests('GET').length;

  fireEvent.keyDown(await screen.findByRole('button', { name: 'Move One' }), { key: 'ArrowDown' });

  expect((await screen.findByRole('alert')).textContent).toContain('Nope');
  expect(requests('PATCH')).toHaveLength(1);
  await waitFor(() => expect(requests('GET').length).toBeGreaterThan(before));
});
