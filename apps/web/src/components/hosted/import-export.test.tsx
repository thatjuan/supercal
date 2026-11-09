import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Access } from './data.ts';
import { hosted } from './fixtures.ts';
import { ImportExport, MAX_IMPORT_BYTES } from './import-export.tsx';

const ICS = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
const mount = (access: Access = 'write') => render(<ImportExport calendar={hosted('cal_1', { name: 'Team', access })} />);
const choose = (file: File) => fireEvent.change(screen.getByLabelText('Calendar file'), { target: { files: [file] } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Import' }));

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(cleanup);

test('refuses an oversized file before any request', () => {
  respondWith({});
  mount();
  const file = new File(['x'], 'big.ics', { type: 'text/calendar' });
  Object.defineProperty(file, 'size', { value: MAX_IMPORT_BYTES + 1 });
  choose(file);
  expect(screen.getByRole('alert').textContent).toContain('8 MiB');
  submit();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('sends the text as a raw body with the conflict choice, and lists failed entries', async () => {
  respondWith({}, () => Response.json({ created: 2, updated: 0, skipped: 1, failed: [{ uid: 'bad@x', reason: 'invalid-calendar-data' }, { uid: '', reason: 'Missing UID' }] }));
  mount();
  choose(new File([ICS], 'cal.ics', { type: 'text/calendar' }));
  fireEvent.change(screen.getByLabelText('When an event already exists'), { target: { value: 'replace' } });
  submit();

  const status = await screen.findByRole('status');
  expect(status.textContent).toContain('2 created');
  expect(status.textContent).toContain('1 skipped');
  expect(status.textContent).toContain('bad@x: invalid-calendar-data');
  expect(status.textContent).toContain('No UID: Missing UID');

  const [request] = requests('POST');
  expect(new URL(request?.url ?? '').search).toBe('?onConflict=replace');
  expect(request?.headers.get('content-type')).toBe('text/calendar');
  expect(await request?.clone().text()).toBe(ICS);
});

test('a problem from the server shows through the alert', async () => {
  respondWith({}, () => Response.json({ type: 'about:blank', title: 'Calendar contains no VEVENT', status: 422 }, { status: 422, headers: { 'content-type': 'application/problem+json' } }));
  mount();
  choose(new File([ICS], 'cal.ics'));
  submit();
  expect((await screen.findByRole('alert')).textContent).toContain('Calendar contains no VEVENT');
});

test('read access can export but not import', () => {
  mount('read');
  const link = screen.getByRole<HTMLAnchorElement>('link', { name: 'Export .ics' });
  expect(link.getAttribute('href')).toBe('/api/v1/calendars/cal_1/export.ics');
  expect(link.getAttribute('download')).toBe('Team.ics');
  expect(screen.queryByLabelText('Calendar file')).toBeNull();
});
