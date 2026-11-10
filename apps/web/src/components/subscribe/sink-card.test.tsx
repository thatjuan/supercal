import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SinkCard } from './sink-card.tsx';
import { consentReturn, consentReturnTo, sinkSearch, type Sink } from './sinks.ts';

const pub = { id: 'pub_work', name: 'Work' };
const account = { id: 'acc_g1', displayName: 'Sam', email: 'sam@gmail.com' };
const sink = (status: Sink['status'], extra: Partial<Sink> = {}): Sink => ({
  id: `snk_${status}`,
  publicationId: pub.id,
  accountId: account.id,
  calendarId: 'c@group.calendar.google.com',
  status,
  lastWriteAt: null,
  problem: null,
  error: null,
  counts: { events: 3 },
  createdAt: '2026-11-07T10:00:00Z',
  ...extra,
});

afterEach(cleanup);

describe('SinkCard', () => {
  test('explains the overwrite, shows each sink’s status, and offers recreate only for a missing calendar', () => {
    const onRemove = vi.fn();
    const onRecreate = vi.fn();
    render(
      <SinkCard
        publications={[pub]}
        accounts={[account]}
        sinks={[sink('up_to_date', { problem: 'Could not mirror 1 events; first: bad: no DTSTART' }), sink('error', { error: 'Google answered 500' }), sink('calendar_missing')]}
        busy={false}
        problem={null}
        onMirror={() => {}}
        onRemove={onRemove}
        onRecreate={onRecreate}
      />,
    );
    expect(screen.getByText(/Edits made to that calendar in Google are overwritten/)).toBeTruthy();
    for (const label of ['Up to date', 'Error', 'Calendar missing']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('Google answered 500')).toBeTruthy();
    expect(screen.getByText('Could not mirror 1 events; first: bad: no DTSTART')).toBeTruthy();
    // Every account already mirrors Work, so there is nothing left to mirror to.
    expect(screen.queryByRole('button', { name: /Mirror to Google account/ })).toBeNull();

    const recreate = screen.getAllByRole('button', { name: 'Recreate' });
    expect(recreate).toHaveLength(1);
    fireEvent.click(recreate[0] as HTMLElement);
    expect(onRecreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'calendar_missing' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement);
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ status: 'up_to_date' }));
  });

  test('without a Google account it says where to connect one', () => {
    render(<SinkCard publications={[pub]} accounts={[]} sinks={[]} busy={false} problem={null} onMirror={() => {}} onRemove={() => {}} onRecreate={() => {}} />);
    expect(screen.getByText(/Connect a Google account/)).toBeTruthy();
  });
});

describe('the consent round trip', () => {
  test('the return address remembers the sink, and coming back creates it or explains the refusal', () => {
    const back = new URL(consentReturnTo('feed_1', 'pub_work', 'acc_g1'), 'https://cal.example');
    expect(back.pathname).toBe('/feeds/feed_1/subscribe');
    const search = sinkSearch({ ...Object.fromEntries(back.searchParams), ignored: 1 });
    expect(consentReturn({ ...search, accountId: 'acc_g1' })).toEqual({ create: { publicationId: 'pub_work', accountId: 'acc_g1' } });
    expect(consentReturn({ ...search, error: 'consent_declined' })).toEqual({ error: expect.stringContaining('nothing was mirrored') });
    expect(consentReturn({ accountId: 'acc_g1' })).toBeNull();
  });
});
