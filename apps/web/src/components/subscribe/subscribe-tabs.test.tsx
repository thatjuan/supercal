import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FeedSecrets } from '../../secrets.ts';
import type { SubscribeInfo } from './links.ts';
import { SubscribeTabs, type SubscribeTab } from './subscribe-tabs.tsx';

/** A payload shaped like `GET /feeds/{id}/subscribe` (apps/daemon/src/api/subscribe.ts) for two publications. */
const info: SubscribeInfo = {
  caldav: {
    serverUrl: 'https://cal.example/dav/',
    username: 'ada-x7k2',
    principalUrl: 'https://cal.example/dav/ada-x7k2/',
    wellKnown: 'https://cal.example/.well-known/caldav',
  },
  ics: {
    hasToken: true,
    publications: [
      { id: 'pub_01h455vb4pex5vsknk084sn02q', name: 'Work', path: '/ics/{token}/work.ics' },
      { id: 'pub_01h455vb4pex5vsknk084sn02r', name: 'Family', path: '/ics/{token}/family.ics' },
    ],
    combinedPath: '/ics/{token}/all.ics',
  },
  links: {
    google: 'https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fcal.example%2Fics%2F{token}%2Fall.ics',
    outlookPersonal: 'https://outlook.live.com/calendar/0/addfromweb?url=https%3A%2F%2Fcal.example%2Fics%2F{token}%2Fall.ics&name=My%20calendars',
    outlookWork: 'https://outlook.office.com/calendar/0/addfromweb?url=https%3A%2F%2Fcal.example%2Fics%2F{token}%2Fall.ics&name=My%20calendars',
  },
  appleProfileUrl: '/api/v1/feeds/feed_1/mobileconfig',
  freshness: { caldav: 'client polls, typically 1–15 min', google: '6–24 hours', outlook: 'about 3–6 hours' },
};

const held: FeedSecrets = { icsToken: 'tok_abc-123', caldavPassword: 'app-password-1' };

const renderTab = (tab: SubscribeTab, secrets: FeedSecrets = held) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SubscribeTabs feedId="feed_1" info={info} secrets={secrets} defaultTab={tab} />
    </QueryClientProvider>,
  );

const value = (label: string) => screen.getByRole<HTMLInputElement>('textbox', { name: label }).value;
const hrefs = (name: string) => screen.getAllByRole('link', { name }).map((link) => link.getAttribute('href'));

afterEach(cleanup);

describe('SubscribeTabs with the secrets held', () => {
  test('Apple: profile download, the password, and manual CalDAV details', () => {
    renderTab('apple');
    expect(screen.getByRole('link', { name: 'Download profile' }).getAttribute('href')).toBe('/api/v1/feeds/feed_1/mobileconfig');
    expect(value('Password')).toBe('app-password-1');
    expect(value('Server URL')).toBe('https://cal.example/dav/');
    expect(value('Username')).toBe('ada-x7k2');
  });

  test('Google: one link for the combined feed and one per publication, webcal inside', () => {
    renderTab('google');
    const cid = (slug: string) => `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(`webcal://cal.example/ics/tok_abc-123/${slug}.ics`)}`;
    expect(hrefs('Add to Google Calendar')).toEqual([cid('all'), cid('work'), cid('family')]);
    expect(screen.getByText(/every 6–24 hours/)).toBeTruthy();
  });

  test('Outlook: personal and work links, plus the ICS link to paste', () => {
    renderTab('outlook');
    expect(hrefs('Add to Outlook.com')).toEqual([info.links.outlookPersonal.replace('{token}', 'tok_abc-123')]);
    expect(hrefs('Add to Outlook (work or school)')).toEqual([info.links.outlookWork.replace('{token}', 'tok_abc-123')]);
    expect(value('ICS link')).toBe('https://cal.example/ics/tok_abc-123/all.ics');
  });

  test.each(['android', 'other'] as const)('%s: CalDAV server URL, username and password', (tab) => {
    renderTab(tab);
    expect(value('Server URL')).toBe('https://cal.example/dav/');
    expect(value('Username')).toBe('ada-x7k2');
    expect(value('Password')).toBe('app-password-1');
  });

  test('Android: a QR code of the well-known URL', () => {
    renderTab('android');
    expect(screen.getByRole('img', { name: 'QR code of the CalDAV server URL' })).toBeTruthy();
  });

  test('Any app: webcal and https for the combined feed and each publication, each with copy and QR', () => {
    renderTab('ics');
    for (const [name, slug] of [['All calendars (combined)', 'all'], ['Work', 'work'], ['Family', 'family']] as const) {
      expect(value(`${name}: webcal`)).toBe(`webcal://cal.example/ics/tok_abc-123/${slug}.ics`);
      expect(value(`${name}: https`)).toBe(`https://cal.example/ics/tok_abc-123/${slug}.ics`);
      expect(screen.getByRole('button', { name: `Copy webcal link for ${name}` })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: `QR code: ${name}` })).toHaveLength(2);
    }
  });
});

describe('SubscribeTabs without the secrets', () => {
  test.each(['google', 'outlook', 'ics'] as const)('%s asks to show links, which rotates', (tab) => {
    renderTab(tab, {});
    expect(screen.getByRole('button', { name: 'Show links' })).toBeTruthy();
    expect(screen.getByText(/old links stop working/)).toBeTruthy();
    expect(screen.queryByText(/tok_/)).toBeNull();
  });

  test('CalDAV tabs offer a new password instead of showing one', () => {
    renderTab('other', {});
    expect(screen.queryByRole('textbox', { name: 'Password' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New password' })).toBeTruthy();
  });
});
