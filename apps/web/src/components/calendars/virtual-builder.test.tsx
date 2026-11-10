import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stubMatchMedia } from '../../test/match-media.ts';
import type { AccountGroup, Calendar } from './data.ts';
import { NEEDS_TWO, VirtualBuilder } from './virtual-builder.tsx';

const calendar = (id: string, accountId: string, name: string): Extract<Calendar, { kind: 'connected' }> => ({
  id,
  kind: 'connected', writable: false,
  access: 'owner',
  owner: { id: 'user_1', name: 'Owner' },
  description: null,
  sortOrder: 0,
  updatedAt: '2026-11-08T00:00:00Z',
  goneAt: null,
  accountId,
  name,
  color: '#2f80ed',
  timezone: null,
  state: 'active',
  capabilities: { incremental: 'none', push: false, write: false },
  freshness: { lastSuccessAt: null, pushActive: false, expectedLatency: null, stale: false },
  publicationIds: [],
});

const row = (c: Calendar) => ({ calendar: c, passthrough: undefined, virtuals: [] });
const groups: AccountGroup[] = [
  { id: 'acc_1', title: 'Work account', subtitle: 'ICS link', rows: [row(calendar('cal_work', 'acc_1', 'Work')), row(calendar('cal_team', 'acc_1', 'Team'))] },
  { id: 'acc_2', title: 'Home account', subtitle: 'ICS link', rows: [row(calendar('cal_home', 'acc_2', 'Home'))] },
];

beforeEach(stubMatchMedia);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => {
  const onSubmit = vi.fn();
  render(<VirtualBuilder groups={groups} onSubmit={onSubmit} onCancel={() => {}} pending={false} problem={null} />);
  return onSubmit;
};
const pick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create virtual calendar' }));

test('blocks saving with one source and says why', () => {
  const onSubmit = mount();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Merged' } });
  pick('Work');
  create();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe(NEEDS_TWO);

  pick('Home');
  expect(screen.queryByText(NEEDS_TWO)).toBeNull();
});

test('reordering the priority list sets source priorities by position', () => {
  const onSubmit = mount();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work+Home' } });
  pick('Work');
  pick('Team');
  pick('Home');
  // Work, Team, Home → Home to the top → Work below Team.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move Home' }), { key: 'ArrowUp' });
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move Home' }), { key: 'ArrowUp' });
  fireEvent.keyDown(screen.getByRole('button', { name: 'Move Work' }), { key: 'ArrowDown' });
  create();

  expect(onSubmit).toHaveBeenCalledWith({
    settings: expect.objectContaining({
      name: 'Work+Home',
      sources: [
        { calendarId: 'cal_home', priority: 0 },
        { calendarId: 'cal_team', priority: 1 },
        { calendarId: 'cal_work', priority: 2 },
      ],
    }),
    hideIndividuals: false,
  });
});
