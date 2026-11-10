import { fetchMock, requests, respondWith } from '../../../test/fetch-mock.ts';

import { Temporal } from '@js-temporal/polyfill';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { browserZone } from '../../../lib/zones.ts';
import { stubMatchMedia } from '../../../test/match-media.ts';
import { renderApp } from '../../../test/render.tsx';
import type { Access } from '../data.ts';
import { hosted } from '../fixtures.ts';
import { EventsTab } from './events-tab.tsx';
import type { JSEvent } from './form.ts';
import type { CalendarOccurrence, JSCalendar } from './writes.ts';

const CAL = 'cal_1';
const today = Temporal.Now.plainDateISO(browserZone);
const at = (hour: number) => today.toPlainDateTime({ hour }).toZonedDateTime(browserZone).toInstant().toString();
const local = `${today.toString()}T09:00:00`;
const ETAG = '"rev-1"';

const occurrence = (fields: Partial<CalendarOccurrence> = {}): CalendarOccurrence => ({ uid: 'e1', recurrenceId: local, start: at(9), end: at(10), timeZone: 'UTC', allDay: false, title: 'Standup', status: 'confirmed', ...fields });
const event = (fields: Partial<JSEvent> = {}): JSEvent => ({ '@type': 'Event', version: '2.0', uid: 'e1', title: 'Standup', start: local, duration: 'PT1H', timeZone: 'UTC', ...fields });

/** Serves the tab's two reads; anything else goes to `write`. */
function serve(items: CalendarOccurrence[], data: JSCalendar, write?: (request: Request) => Response) {
  respondWith({}, (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname.endsWith('/occurrences')) return Response.json({ items, truncated: false });
    if (request.method === 'GET') return Response.json(data, { headers: { etag: ETAG } });
    return write?.(request) ?? new Response(null, { status: 204 });
  });
}

const renderTab = (access: Access = 'owner', state: 'active' | 'gone' = 'active') => renderApp(<EventsTab loaded={{ calendar: hosted(CAL, { access, state }), etag: '"c"' }} mine reload={() => Promise.resolve(undefined)} />);

const open = async (name = 'Standup') => fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));

beforeEach(() => {
  fetchMock.mockReset();
  Element.prototype.scrollTo = () => {};
  stubMatchMedia();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a writer can create, edit and delete', async () => {
  serve([occurrence()], event());
  await renderTab('write');
  expect(screen.getByRole('button', { name: 'New event' })).toBeTruthy();
  await open();
  expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
});

test.each<[string, Access, 'active' | 'gone']>([
  ['read access', 'read', 'active'],
  ['a deleted calendar', 'owner', 'gone'],
])('%s is read-only: no create button or actions', async (_name, access, state) => {
  serve([occurrence({ title: 'Busy' })], event({ title: 'Busy' }));
  await renderTab(access, state);
  await open('Busy');
  await screen.findByRole('dialog');
  await waitFor(() => expect(requests('GET').some((request) => request.url.includes('/events/'))).toBe(true));
  await screen.findByText('When');
  expect(screen.queryByRole('button', { name: 'New event' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});

test('a Group of detached instances is read-only, but can still be deleted whole', async () => {
  const group: JSCalendar = { '@type': 'Group', version: '2.0', uid: 'e1', entries: [event({ recurrenceId: local, title: 'Standup' })] };
  serve([occurrence()], group);
  await renderTab();
  await open();
  await screen.findByText('Edit this event in the app that created it');
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const confirm = await screen.findByRole('dialog', { name: /Delete/ });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(requests('DELETE')).toHaveLength(1));
  expect(requests('DELETE')[0]?.headers.get('if-match')).toBe(ETAG);
});

test('a recurring event asks for a scope, and offers no split on its first occurrence', async () => {
  serve([occurrence()], event({ recurrenceRule: { frequency: 'weekly' } }));
  await renderTab();
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByRole('button', { name: 'This event' });
  expect(screen.getByRole('button', { name: 'All events' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'This and following' })).toBeNull();
});

test('a later occurrence can be split', async () => {
  const later = today.add({ weeks: 1 });
  serve([occurrence({ recurrenceId: `${later.toString()}T09:00:00` })], event({ recurrenceRule: { frequency: 'weekly' } }));
  await renderTab();
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('button', { name: 'This and following' })).toBeTruthy();
});

test('a custom rule is shown and cannot be edited', async () => {
  serve([occurrence()], event({ recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 1 }] } }));
  await renderTab();
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'All events' }));
  await screen.findByText('Custom repeat, set in another app');
  expect(screen.queryByLabelText('Repeat')).toBeNull();
});

test('attendees are shown read-only, with the note, and stay out of the patch', async () => {
  serve([occurrence()], event({ participants: { p1: { name: 'Grace', calendarAddress: 'mailto:grace@example.invalid' } } }), () => Response.json(event(), { headers: { etag: '"rev-2"' } }));
  await renderTab();
  await open();
  await screen.findByText('Grace');
  screen.getByText('Supercal doesn’t send invitations.');

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Sync' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(requests('PATCH')).toHaveLength(1));
  expect(await requests('PATCH')[0]?.clone().json()).toEqual({ title: 'Sync' });
  expect(requests('PATCH')[0]?.headers.get('if-match')).toBe(ETAG);
});

test.each([false, true])('a 412 on connected=%s keeps the draft, refreshes the event and offers Reload', async (connected) => {
  let version = 'Standup';
  respondWith({}, (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname.endsWith('/occurrences')) return Response.json({ items: [occurrence()], truncated: false });
    if (request.method === 'GET') return Response.json(event({ title: version }), { headers: { etag: `"${version}"` } });
    return Response.json({ type: 'about:blank', title: 'Precondition failed', status: 412 }, { status: 412, headers: { 'content-type': 'application/problem+json' } });
  });
  const calendar = connected ? { ...hosted(CAL), kind: 'connected' as const, accountId: 'acc_1' } : hosted(CAL);
  await renderApp(<EventsTab loaded={{ calendar, etag: '"c"' }} mine reload={() => Promise.resolve(undefined)} />);
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const title = () => screen.getByLabelText<HTMLInputElement>('Title');
  await screen.findByLabelText('Title');
  fireEvent.change(title(), { target: { value: 'My typing' } });
  version = 'Renamed elsewhere';
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect((await screen.findByRole('alert')).textContent).toContain('This event changed elsewhere');
  expect(title().value).toBe('My typing');
  await waitFor(() => expect(requests('GET').filter((request) => request.url.includes('/events/')).length).toBeGreaterThanOrEqual(2));

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(title().value).toBe('Renamed elsewhere'));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a 400 shows on its field; one with no field goes to the alert', async () => {
  serve([occurrence()], event(), () => Response.json({ type: 'about:blank', title: 'Invalid request', status: 400, errors: [{ path: 'title', message: 'Too long' }, { path: 'alerts/a1', message: 'Bad alert' }] }, { status: 400, headers: { 'content-type': 'application/problem+json' } }));
  await renderTab();
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Sync' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Too long')).toBeTruthy();
  expect(within(screen.getByRole('alert')).getByText('Bad alert')).toBeTruthy();
});

test('a truncated week says the view is incomplete, and a cancelled event is struck through', async () => {
  respondWith({}, (request) => (new URL(request.url).pathname.endsWith('/occurrences') ? Response.json({ items: [occurrence({ status: 'cancelled' })], truncated: true }) : new Response(null, { status: 404 })));
  await renderTab();
  expect((await screen.findByRole('status')).textContent).toContain('incomplete');
  expect(screen.getByText('Standup').className).toContain('line-through');
});

test.each([true, false])('connected calendar editor actions follow writable=%s', async (writable) => {
  serve([occurrence()], event());
  const calendar = { ...hosted(CAL, { access: 'write', writable }), kind: 'connected' as const, accountId: 'acc_1' };
  await renderApp(<EventsTab loaded={{ calendar, etag: '"c"' }} mine reload={() => Promise.resolve(undefined)} />);
  expect(Boolean(screen.queryByRole('button', { name: 'New event' }))).toBe(writable);
  await open();
  await screen.findByText('When');
  expect(Boolean(screen.queryByRole('button', { name: 'Edit' }))).toBe(writable);
  expect(Boolean(screen.queryByRole('button', { name: 'Delete' }))).toBe(writable);
});

test('a connected provider refusal displays the problem detail', async () => {
  serve([occurrence()], event(), () => Response.json({ type: 'about:blank', title: 'Unprocessable content', status: 422, detail: 'Provider cannot store this reminder' }, { status: 422, headers: { 'content-type': 'application/problem+json' } }));
  const calendar = { ...hosted(CAL), kind: 'connected' as const, accountId: 'acc_1' };
  await renderApp(<EventsTab loaded={{ calendar, etag: '"c"' }} mine reload={() => Promise.resolve(undefined)} />);
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Changed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Provider cannot store this reminder');
});
