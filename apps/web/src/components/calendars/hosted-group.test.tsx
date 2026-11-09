import { fetchMock, respondWith } from '../../test/fetch-mock.ts';

import type { components } from '@supercal/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stubMatchMedia } from '../../test/match-media.ts';
import { hosted, ME_ID } from '../hosted/fixtures.ts';
import { CalendarList } from './calendar-list.tsx';
import { useFeedCalendars, type Account, type Calendar, type Feed } from './data.ts';
import { VirtualBuilder } from './virtual-builder.tsx';

const feed = { id: 'feed_1', ownerUserId: ME_ID } as Feed;
const account: Account = { id: 'acc_1', provider: 'ics', ownerUserId: ME_ID, displayName: 'Work feed', email: null, serverUrl: null, status: 'active', statusDetail: null, autoPublish: true };
const connected: Calendar = {
  ...hosted('cal_work', { name: 'Work' }),
  kind: 'connected',
  accountId: 'acc_1',
} satisfies components['schemas']['Calendar'];

const COLLEAGUE = { id: 'user_grace', name: 'Grace' };
const calendars = [connected, hosted('cal_mine', { name: 'Mine' }), hosted('cal_theirs', { name: 'Theirs', access: 'owner', owner: COLLEAGUE }), hosted('cal_gone', { name: 'Gone', state: 'gone' })];

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

/** The groups `useFeedCalendars` builds from the API. */
async function loadGroups() {
  const { result } = renderHook(() => useFeedCalendars(feed), { wrapper });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  return result.current;
}

beforeEach(() => {
  stubMatchMedia();
  fetchMock.mockReset();
  respondWith({ '/api/v1/feeds/feed_1/publications': { items: [] }, '/api/v1/accounts': { items: [account] }, '/api/v1/calendars': { items: calendars } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('hosted calendars of the feed owner form a last group; a colleague’s or a deleted one does not', async () => {
  const { groups, calendars: byId } = await loadGroups();
  expect(groups.map(({ id, title, subtitle, rows }) => ({ id, title, subtitle, rows: rows.map((row) => row.calendar.name) }))).toEqual([
    { id: 'acc_1', title: 'Work feed', subtitle: 'ICS link', rows: ['Work'] },
    { id: 'hosted', title: 'Hosted', subtitle: 'Supercal', rows: ['Mine'] },
  ]);
  expect(byId.get('cal_mine')?.name).toBe('Mine');
});

test('no hosted group when the owner has no active hosted calendar', async () => {
  respondWith({ '/api/v1/feeds/feed_1/publications': { items: [] }, '/api/v1/accounts': { items: [account] }, '/api/v1/calendars': { items: [connected] } });
  expect((await loadGroups()).groups.map((group) => group.id)).toEqual(['acc_1']);
});

test('a hosted row says Hosted where a connected row shows its freshness', async () => {
  const { groups } = await loadGroups();
  render(<CalendarList feed={feed} groups={groups} onOpen={() => {}} />, { wrapper });
  const [work, mine] = screen.getAllByTestId('calendar-row');
  expect(within(work as HTMLElement).getByText('not synced yet')).toBeTruthy();
  expect(within(mine as HTMLElement).queryByText('not synced yet')).toBeNull();
  expect(within(mine as HTMLElement).getByText('Hosted')).toBeTruthy();
});

test('a hosted calendar can be picked in the virtual builder and labels itself Hosted', async () => {
  const { groups } = await loadGroups();
  render(<VirtualBuilder groups={groups} initial={{ name: 'Merged', color: null, privacy: 'full', filters: { hideDeclined: false, hideCancelled: false, hideAllDay: false }, keepAlarms: false, sources: [{ calendarId: 'cal_mine', priority: 0 }] }} onSubmit={() => {}} onCancel={() => {}} pending={false} problem={null} />);
  expect(screen.getByRole('group', { name: 'Hosted' })).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Source priority' })).getByText('· Hosted')).toBeTruthy();
});
