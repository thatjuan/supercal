import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import { Temporal } from '@js-temporal/polyfill';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { browserZone } from '../../lib/zones.ts';
import { renderApp } from '../../test/render.tsx';
import { weekOf } from '../preview/layout.ts';
import { AvailabilityTab } from './availability.tsx';
import { freeBusy } from './fixtures.ts';

const week = weekOf(Temporal.Now.plainDateISO(browserZone));
const dayAt = (index: number, hour: number) => {
  const day = week[index];
  if (!day) throw new Error(`No day ${index}`);
  return day.toZonedDateTime({ timeZone: browserZone, plainTime: Temporal.PlainTime.from({ hour }) }).toInstant().toString();
};
const dayRow = (index: number) => within(screen.getByRole('listitem', { name: week[index]?.toLocaleString('en', { weekday: 'long', month: 'short', day: 'numeric' }) ?? '' }));

async function show(result: unknown) {
  respondWith({}, () => Response.json({ calendars: { cal_1: result } }));
  await renderApp(<AvailabilityTab loaded={{ calendar: freeBusy('cal_1', 'Grace'), etag: 'W/"1"' }} mine={false} reload={() => Promise.resolve(undefined)} />);
}

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a not-accessible result says so, and queries only this calendar over the week', async () => {
  await show({ error: 'not-accessible' });

  await screen.findByText('You can’t see this calendar’s availability.');
  expect(screen.queryByText('Free all day')).toBeNull();
  const body: unknown = await requests('POST')[0]?.clone().json();
  expect(body).toMatchObject({ calendarIds: ['cal_1'], from: dayAt(0, 0) });
});

test('a day with no intervals is free all day', async () => {
  await show({ busy: [], truncated: false });

  await screen.findByRole('list', { name: 'Availability by day' });
  for (const index of week.keys()) dayRow(index).getByText('Free all day');
  expect(screen.queryByRole('status')).toBeNull();
});

test('an interval crossing midnight shows on both days, cut at midnight', async () => {
  await show({ busy: [{ start: dayAt(0, 22), end: dayAt(1, 2), status: 'busy' }], truncated: false });

  await screen.findByRole('list', { name: 'Availability by day' });
  dayRow(0).getByText('22:00–00:00');
  dayRow(0).getByText('Busy');
  dayRow(1).getByText('00:00–02:00');
  dayRow(1).getByText('Busy');
  dayRow(2).getByText('Free all day');
});

test('tentative time is labelled as such, apart from busy time', async () => {
  await show({
    busy: [
      { start: dayAt(2, 9), end: dayAt(2, 10), status: 'tentative' },
      { start: dayAt(2, 11), end: dayAt(2, 12), status: 'busy' },
    ],
    truncated: false,
  });

  await screen.findByRole('list', { name: 'Availability by day' });
  dayRow(2).getByText('09:00–10:00');
  dayRow(2).getByText('Tentative');
  dayRow(2).getByText('Busy');
});

test('a truncated result says it may be incomplete', async () => {
  await show({ busy: [], truncated: true });

  expect((await screen.findByRole('status')).textContent).toContain('may be incomplete');
});
