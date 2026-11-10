import { fetchMock, requests, respondWith } from '../../test/fetch-mock.ts';

import type { components } from '@supercal/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import type { Access } from './data.ts';
import { hosted, me, ME_ID } from './fixtures.ts';
import { SharingTab } from './sharing.tsx';

const user = (id: string, name: string) => ({ id, name, email: `${name.toLowerCase()}@example.invalid` });
const GRACE = user('user_grace', 'Grace');
const LIN = user('user_lin', 'Lin');

vi.mock('../../auth.ts', () => ({
  authClient: {
    organization: {
      getFullOrganization: () =>
        Promise.resolve({
          data: { invitations: [], members: [{ user: { id: ME_ID, name: 'Ada', email: 'ada@example.invalid' } }, { user: { id: 'user_grace', name: 'Grace', email: 'grace@example.invalid' } }, { user: { id: 'user_lin', name: 'Lin', email: 'lin@example.invalid' } }] },
          error: null,
        }),
    },
  },
}));

type Share = components['schemas']['CalendarShare'];

const personal = (who: { id: string; name: string; email: string }, access: Share['access']): Share => ({
  id: `shr_${who.name}`,
  grantee: { type: 'user', userId: who.id },
  access,
  user: who,
  createdBy: ME_ID,
  createdAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
  etag: `W/"${who.name}"`,
});
const everyone = (access: Share['access']): Share => ({ ...personal(GRACE, access), id: 'shr_tenant', grantee: { type: 'tenant' }, user: null, etag: 'W/"tenant"' });

const problem = (status: number, title: string) => Response.json({ type: 'about:blank', title, status }, { status, headers: { 'content-type': 'application/problem+json' } });

async function show(access: Access, items: Share[], write?: (request: Request) => Response) {
  respondWith({ '/api/v1/me': me, '/api/v1/calendars/cal_1/shares': { items } }, write);
  return renderApp(<SharingTab loaded={{ calendar: hosted('cal_1', { access }), etag: 'W/"1"' }} mine={access === 'owner'} reload={() => Promise.resolve(undefined)} />);
}

const optionsOf = (select: HTMLElement) => within(select).getAllByRole('option').map((option) => option.textContent);
const picker = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Share with' });

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a manager gets no manage option anywhere, and a manage row is read-only', async () => {
  await show('manage', [personal(GRACE, 'manage'), personal(LIN, 'read')]);

  const manager = await screen.findByRole('listitem', { name: 'Grace' });
  expect(within(manager).queryByRole('combobox')).toBeNull();
  expect(within(manager).queryByRole('button', { name: 'Remove' })).toBeNull();
  within(manager).getByText('Manage');

  const reader = screen.getByRole('listitem', { name: 'Lin' });
  expect(optionsOf(within(reader).getByRole('combobox'))).toEqual(['Free/busy only', 'See events', 'Edit events']);
  within(reader).getByRole('button', { name: 'Remove' });
  expect(optionsOf(screen.getByRole('combobox', { name: 'Access' }))).toEqual(['Free/busy only', 'See events', 'Edit events']);
});

test('an owner can change a manage row and grant manage', async () => {
  await show('owner', [personal(GRACE, 'manage')]);

  const manager = await screen.findByRole('listitem', { name: 'Grace' });
  expect(optionsOf(within(manager).getByRole('combobox'))).toContain('Manage');
  within(manager).getByRole('button', { name: 'Remove' });
  expect(optionsOf(screen.getByRole('combobox', { name: 'Access' }))).toContain('Manage');
});

test('the picker lists Everyone first, without the owner or anyone already granted', async () => {
  await show('owner', [personal(GRACE, 'read')]);

  await waitFor(() => expect(optionsOf(picker())).toEqual(['Choose someone', 'Everyone in Acme', 'Lin (lin@example.invalid)']));
});

test('a tenant-wide grant takes Everyone out of the picker and labels its row', async () => {
  await show('owner', [everyone('read')]);

  await screen.findByRole('listitem', { name: 'Everyone in Acme' });
  await waitFor(() => expect(optionsOf(picker())).toEqual(['Choose someone', 'Grace (grace@example.invalid)', 'Lin (lin@example.invalid)']));
});

test('a personal grant is labelled with the person’s name and email', async () => {
  await show('owner', [personal(GRACE, 'read')]);

  const row = await screen.findByRole('listitem', { name: 'Grace' });
  within(row).getByText('grace@example.invalid');
});

test('changing access sends the row’s ETag as If-Match', async () => {
  await show('owner', [personal(GRACE, 'read')], () => Response.json(personal(GRACE, 'write')));

  const row = await screen.findByRole('listitem', { name: 'Grace' });
  fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'write' } });

  await waitFor(() => expect(requests('PATCH')).toHaveLength(1));
  const [request] = requests('PATCH');
  expect(new URL(request?.url ?? '').pathname).toBe('/api/v1/calendars/cal_1/shares/shr_Grace');
  expect(request?.headers.get('if-match')).toBe('W/"Grace"');
  expect(await request?.clone().json()).toEqual({ access: 'write' });
});

test('a 412 refetches the list and says the share changed', async () => {
  await show('owner', [personal(GRACE, 'read')], () => problem(412, 'Precondition failed'));

  const row = await screen.findByRole('listitem', { name: 'Grace' });
  const before = requests('GET').length;
  fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'write' } });

  expect((await within(row).findByRole('alert')).textContent).toContain('This share changed elsewhere');
  expect(requests('GET').length).toBeGreaterThan(before);
  await waitFor(() => expect(within(row).getByRole<HTMLSelectElement>('combobox').value).toBe('read'));
});

test('sharing with Everyone sends the tenant grantee', async () => {
  await show('owner', [], () => Response.json(everyone('read'), { status: 201 }));

  await waitFor(() => expect(optionsOf(picker())).toContain('Everyone in Acme'));
  const share = screen.getByRole<HTMLButtonElement>('button', { name: 'Share' });
  expect(share.disabled).toBe(true);
  fireEvent.change(picker(), { target: { value: 'everyone' } });
  fireEvent.click(share);

  await waitFor(() => expect(requests('POST')).toHaveLength(1));
  expect(await requests('POST')[0]?.clone().json()).toEqual({ grantee: { type: 'tenant' }, access: 'read' });
});

test('a 409 says a grant already exists and refetches', async () => {
  await show('owner', [], () => problem(409, 'A grant already exists for this grantee'));

  await waitFor(() => expect(optionsOf(picker())).toContain('Lin (lin@example.invalid)'));
  const before = requests('GET').length;
  fireEvent.change(picker(), { target: { value: LIN.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));

  expect((await screen.findByRole('alert')).textContent).toContain('already exists');
  expect(await requests('POST')[0]?.clone().json()).toEqual({ grantee: { type: 'user', userId: LIN.id }, access: 'read' });
  expect(requests('GET').length).toBeGreaterThan(before);
});

test.each([true, false])('connected sharing offers event editing only when writable=%s and never manage', async (writable) => {
  respondWith({ '/api/v1/me': me, '/api/v1/accounts': { items: [{ id: 'acc_1', provider: 'google' }] }, '/api/v1/calendars/cal_1/shares': { items: [] } });
  const calendar = { ...hosted('cal_1', { writable }), kind: 'connected' as const, accountId: 'acc_1' };
  await renderApp(<SharingTab loaded={{ calendar, etag: '"c"' }} mine reload={() => Promise.resolve(undefined)} />);
  const options = optionsOf(await screen.findByRole('combobox', { name: 'Access' }));
  expect(options.includes('Edit events')).toBe(writable);
  expect(options).not.toContain('Manage');
  if (writable) expect(await screen.findByText("Edits are made in the owner's Google account.")).toBeTruthy();
});
