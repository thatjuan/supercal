import type { Problem } from '@supercal/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RemoveDialog } from './account-dialogs.tsx';
import { CaldavForm, IcloudForm, IcsForm } from './credential-forms.tsx';
import type { Account, AccountHealth, Calendar } from './health.ts';
import type { FormProvider } from './providers.tsx';
import { StatusBadge } from './status.tsx';

afterEach(cleanup);

const withQueries = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const problem = (slug: string, status = 422): Problem => ({ type: `https://supercal.dev/problems/${slug}`, title: 'Unprocessable', status, detail: 'raw detail' });

describe('StatusBadge', () => {
  test.each<[AccountHealth, string]>([
    ['active', 'Active'],
    ['syncing', 'Syncing'],
    ['reauth_required', 'Reconnect needed'],
    ['error', 'Error'],
    ['disabled', 'Disabled'],
  ])('%s reads “%s”', (health, label) => {
    render(<StatusBadge health={health} />);
    expect(screen.getByText(label)).toBeTruthy();
  });
});

/** Each form, how to fill it validly, and what it submits. */
const FORMS = {
  ics: {
    render: (onSubmit: (values: unknown) => Promise<unknown>) => render(<IcsForm onSubmit={onSubmit} />),
    fill: () => fireEvent.change(screen.getByLabelText('Calendar link'), { target: { value: 'webcal://cal.example/a.ics' } }),
    submitted: { url: 'webcal://cal.example/a.ics' },
    required: ['Enter the calendar link'],
  },
  caldav: {
    render: (onSubmit: (values: unknown) => Promise<unknown>) => render(<CaldavForm onSubmit={onSubmit} />),
    fill: () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fastmail' }));
      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ada' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    },
    submitted: { serverUrl: 'https://caldav.fastmail.com/', username: 'ada', password: 'secret' },
    required: ['Enter the server URL', 'Enter your username', 'Enter your password'],
  },
  icloud: {
    render: (onSubmit: (values: unknown) => Promise<unknown>) => render(<IcloudForm onSubmit={onSubmit} />),
    fill: () => {
      fireEvent.change(screen.getByLabelText('Apple ID'), { target: { value: 'ada@icloud.com' } });
      fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    },
    submitted: { appleId: 'ada@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
    required: ['Enter your Apple ID', 'Enter an app-specific password'],
  },
} satisfies Record<FormProvider, unknown>;

const submit = () => fireEvent.click(screen.getByRole('button', { name: /^Connect/ }));

describe.each(Object.entries(FORMS))('%s form', (_provider, form) => {
  test('requires its fields before submitting', () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    form.render(onSubmit);
    submit();
    for (const message of form.required) expect(screen.getByText(message)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('submits the API’s shape', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    form.render(onSubmit);
    form.fill();
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(form.submitted));
  });

  test.each([
    ['invalid-credentials', /rejected|refused/],
    ['unsupported-auth', /Digest/],
    ['egress-blocked', /cannot reach private network addresses .* unless the operator allows them/],
    ['provider-unavailable', /did not answer/],
  ])('shows %s in plain words', async (slug, message) => {
    form.render(() => Promise.reject(problem(slug, slug === 'provider-unavailable' ? 503 : 422)));
    form.fill();
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
  });
});

test('field errors from a 400 land on their fields', async () => {
  FORMS.ics.render(() => Promise.reject({ ...problem('validation', 400), errors: [{ path: 'url', message: 'Invalid URL' }] }));
  FORMS.ics.fill();
  submit();
  expect(await screen.findByText('Invalid URL')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the CalDAV form rejects an unfilled Nextcloud preset and a non-http URL', () => {
  FORMS.caldav.render(vi.fn());
  fireEvent.click(screen.getByRole('button', { name: 'Nextcloud' }));
  submit();
  expect(screen.getByText('Replace <host> with your server’s address')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'ftp://dav.example' } });
  submit();
  expect(screen.getByText('Enter a URL starting with https://')).toBeTruthy();
});

test('the iCloud form explains rejected credentials with app-specific passwords', async () => {
  FORMS.icloud.render(() => Promise.reject(problem('invalid-credentials')));
  FORMS.icloud.fill();
  submit();
  expect((await screen.findByRole('alert')).textContent).toContain('Use an app-specific password, not your Apple ID password');
});

describe('RemoveDialog', () => {
  const account: Account = {
    id: 'acc_1',
    provider: 'ics',
    ownerUserId: 'u',
    displayName: 'Team',
    email: null,
    serverUrl: 'cal.example',
    status: 'active',
    statusDetail: null,
    autoPublish: true,
  };
  const calendar = (id: string, publicationIds: string[]): Calendar => ({
    id,
    kind: 'connected',
    description: null,
    sortOrder: 0,
    updatedAt: '2026-11-08T00:00:00Z',
    goneAt: null,
    accountId: 'acc_1',
    name: id,
    color: null,
    timezone: null,
    state: 'active',
    capabilities: { incremental: 'none', push: false },
    freshness: { lastSuccessAt: null, pushActive: false, expectedLatency: null, stale: false },
    publicationIds,
  });

  test('shows how many calendars leave how many publications', () => {
    // Two calendars share the virtual publication pub_v, so three publications in all.
    const calendars = [calendar('cal_a', ['pub_a', 'pub_v']), calendar('cal_b', ['pub_b', 'pub_v'])];
    withQueries(<RemoveDialog account={account} calendars={calendars} open onOpenChange={() => {}} onRemoved={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Remove Team?' }).textContent).toContain('Removes 2 calendars from 3 publications.');
  });

  test('uses the singular for one of each', () => {
    withQueries(<RemoveDialog account={account} calendars={[calendar('cal_a', ['pub_a'])]} open onOpenChange={() => {}} onRemoved={() => {}} />);
    expect(screen.getByText('Removes 1 calendar from 1 publication.')).toBeTruthy();
  });
});
