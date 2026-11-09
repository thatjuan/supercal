/**
 * Hosted calendars against a real daemon: the calendar's life from creation to restore, importing
 * and exporting a file, a device login that really opens CalDAV, and the event editor.
 */
import { Temporal } from '@js-temporal/polyfill';
import { expect, test, type Page } from '@playwright/test';
import { ics } from './fixture.ts';

async function signUp(page: Page, who: string) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(`${who}-${Date.now()}@example.invalid`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
}

const nav = (page: Page, name: 'Calendars' | 'Hosted' | 'Settings') => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

async function createCalendar(page: Page, name: string) {
  await nav(page, 'Hosted');
  await page.getByRole('button', { name: 'New calendar' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create calendar' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
}

test('create, rename, publish, delete and restore a hosted calendar', async ({ page }) => {
  await signUp(page, 'hosted-life');
  await createCalendar(page, 'Team');
  await expect(page).toHaveURL(/\/hosted\/cal_/);

  await page.getByLabel('Name').fill('Team plans');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Team plans', level: 1 })).toBeVisible();

  await nav(page, 'Calendars');
  const publish = page.getByRole('switch', { name: 'Publish Team plans' });
  await expect(publish).not.toBeChecked();
  await expect(page.getByTestId('calendar-row').filter({ hasText: 'Team plans' }).getByText('Hosted')).toBeVisible();
  await publish.click();
  await expect(publish).toBeChecked();

  await nav(page, 'Hosted');
  await page.getByRole('link', { name: 'Team plans' }).click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delete calendar' }).click();
  await expect(page.getByRole('dialog')).toContainText('restore');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete calendar' }).click();
  await expect(page).toHaveURL(/\/hosted$/);

  const deleted = page.getByRole('region', { name: 'Deleted' }).getByRole('listitem', { name: 'Team plans' });
  await expect(deleted).toContainText('Deleted permanently on');
  await deleted.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(/Its feed publications stay off/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your calendars' }).getByRole('link', { name: 'Team plans' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Deleted' })).toHaveCount(0);

  // Deleting turned its publication off, and restoring leaves it off.
  await nav(page, 'Calendars');
  await expect(page.getByRole('switch', { name: 'Publish Team plans' })).not.toBeChecked();
});

test('import a file into a hosted calendar and export it again', async ({ page }) => {
  await signUp(page, 'hosted-import');
  await createCalendar(page, 'Imported');

  const start = new Date(Date.UTC(2026, 10, 9, 9));
  const body = ics('Source', [{ uid: 'review@e2e', summary: 'Review', start, minutes: 60 }]);
  await page.getByLabel('Calendar file').setInputFiles({ name: 'source.ics', mimeType: 'text/calendar', buffer: Buffer.from(body) });
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 created' })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export .ics' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Imported.ics');
  const exported = await file.createReadStream().then((stream) => new Response(stream as unknown as ReadableStream).text());
  expect(exported).toContain('UID:review@e2e');
});

test('a device login is revealed once and opens CalDAV', async ({ page, baseURL }) => {
  await signUp(page, 'hosted-device');
  await nav(page, 'Hosted');
  await page.getByRole('link', { name: 'Connect an app' }).click();
  await expect(page).toHaveURL(/\/settings#devices$/);

  const panel = page.getByRole('region', { name: 'Calendar apps' });
  await panel.getByRole('button', { name: 'New device' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Work iPhone');
  await dialog.getByRole('button', { name: 'Create login' }).click();

  const username = await dialog.getByLabel('Username', { exact: true }).inputValue();
  const password = await dialog.getByLabel('Password', { exact: true }).inputValue();
  await expect(dialog.getByLabel('Server URL', { exact: true })).toHaveValue(/\/dav\/$/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(panel.getByRole('listitem', { name: 'Work iPhone' })).toContainText('Never used');

  const propfind = await fetch(`${baseURL}/dav/`, {
    method: 'PROPFIND',
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, Depth: '0' },
  });
  expect(propfind.status).toBe(207);
});

test.describe('event editor', () => {
  test.use({ timezoneId: 'UTC' });

  /** The Monday `weeks` weeks after this week's. */
  const monday = (weeks: number) => {
    const today = Temporal.Now.plainDateISO('UTC');
    return today.subtract({ days: today.dayOfWeek - 1 }).add({ weeks });
  };
  const sheet = (page: Page) => page.getByRole('dialog');
  const nextWeek = (page: Page) => page.getByRole('button', { name: 'Next week' }).click();
  const block = (page: Page, title: string) => page.getByTestId('timed-event').filter({ hasText: title });

  async function openEvents(page: Page, who: string) {
    await signUp(page, who);
    await createCalendar(page, 'Plans');
    await page.getByRole('tab', { name: 'Events' }).click();
    const id = /cal_[^/?]+/.exec(page.url())?.[0];
    if (!id) throw new Error(`No calendar id in ${page.url()}`);
    return id;
  }

  /** Creates an event at 09:00 UTC on next Monday, repeating weekly if asked, and shows that week. */
  async function createEvent(page: Page, title: string, { weekly }: { weekly: boolean }) {
    await page.getByRole('button', { name: 'New event' }).click();
    await sheet(page).getByLabel('Title').fill(title);
    await sheet(page).getByLabel('Start date').fill(monday(1).toString());
    await sheet(page).getByLabel('Start time').fill('09:00');
    await sheet(page).getByLabel('Time zone').selectOption('UTC');
    if (weekly) await sheet(page).getByLabel('Repeat').selectOption('weekly');
    await sheet(page).getByRole('button', { name: 'Create event' }).click();
    await expect(sheet(page)).toHaveCount(0);
    await nextWeek(page);
    await expect(block(page, title)).toBeVisible();
  }

  /** `/occurrences` as the page sees it, for the next six weeks, as `[start, title]`. */
  const occurrences = (page: Page, id: string) =>
    page.evaluate(
      async ({ id, from, to }) => {
        const response = await fetch(`/api/v1/calendars/${id}/occurrences?from=${from}&to=${to}`);
        const { items } = (await response.json()) as { items: { uid: string; start: string; title: string }[] };
        return items;
      },
      { id, from: `${monday(0).toString()}T00:00:00Z`, to: `${monday(6).toString()}T00:00:00Z` },
    );
  const startsOf = (items: { start: string }[]) => items.map((item) => item.start);
  const at = (weeks: number, time: string) => `${monday(weeks).toString()}T${time}:00Z`;

  test('create a weekly event and see it in week and agenda views', async ({ page }) => {
    await openEvents(page, 'events-create');
    await createEvent(page, 'Standup', { weekly: true });

    await page.getByRole('button', { name: 'agenda' }).click();
    await expect(page.getByTestId('agenda')).toContainText('Standup');
    await expect(page.getByTestId('agenda')).toContainText('09:00–10:00');

    await page.getByRole('button', { name: 'week', exact: true }).click();
    await nextWeek(page);
    await expect(block(page, 'Standup')).toBeVisible();
  });

  test('move one occurrence and delete another', async ({ page }) => {
    const id = await openEvents(page, 'events-occurrence');
    await createEvent(page, 'Standup', { weekly: true });

    await nextWeek(page);
    await block(page, 'Standup').getByRole('button').click();
    await sheet(page).getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'This event' }).click();
    await sheet(page).getByLabel('Start time').fill('10:00');
    await sheet(page).getByRole('button', { name: 'Save' }).click();
    await expect(sheet(page)).toHaveCount(0);

    await nextWeek(page);
    await block(page, 'Standup').getByRole('button').click();
    await sheet(page).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'This event' }).click();
    await page.getByRole('dialog', { name: /^Delete/ }).getByRole('button', { name: 'Delete' }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(block(page, 'Standup')).toHaveCount(0);

    expect(startsOf(await occurrences(page, id))).toEqual([at(1, '09:00'), at(2, '10:00'), at(4, '09:00'), at(5, '09:00')]);
  });

  test('this and following changes a later occurrence on, and is not offered on the first', async ({ page }) => {
    const id = await openEvents(page, 'events-split');
    await createEvent(page, 'Old name', { weekly: true });

    await block(page, 'Old name').getByRole('button').click();
    await sheet(page).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('button', { name: 'All events' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'This and following' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await sheet(page).getByRole('button', { name: 'Close' }).click();

    await nextWeek(page);
    await nextWeek(page);
    await block(page, 'Old name').getByRole('button').click();
    await sheet(page).getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'This and following' }).click();
    await sheet(page).getByLabel('Title').fill('New name');
    await sheet(page).getByRole('button', { name: 'Save' }).click();
    await expect(block(page, 'New name')).toBeVisible();

    await nextWeek(page);
    await expect(block(page, 'New name')).toBeVisible();
    await page.getByRole('button', { name: 'Previous week' }).click();
    await page.getByRole('button', { name: 'Previous week' }).click();
    await expect(block(page, 'Old name')).toBeVisible();

    const items = await occurrences(page, id);
    expect(items.map((item) => [item.start, item.title])).toEqual([
      [at(1, '09:00'), 'Old name'],
      [at(2, '09:00'), 'Old name'],
      [at(3, '09:00'), 'New name'],
      [at(4, '09:00'), 'New name'],
      [at(5, '09:00'), 'New name'],
    ]);
    expect(new Set(items.map((item) => item.uid)).size).toBe(2);
  });

  test('X- properties and attendees written over CalDAV survive a dashboard edit', async ({ page, baseURL }) => {
    const id = await openEvents(page, 'events-dav');
    const login = await page.request.post('/api/v1/dav-logins', { data: { name: 'Script' } });
    expect(login.status()).toBe(201);
    const { username, password } = (await login.json()) as { username: string; password: string };
    const object = `${baseURL}/dav/${username}/cal/${id}/keep.ics`;
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    const dtstart = `${monday(1).toString().replaceAll('-', '')}T090000Z`;
    const put = await fetch(object, {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'text/calendar' },
      body: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Supercal//e2e//EN', 'BEGIN:VEVENT', 'UID:keep@e2e', `DTSTAMP:${dtstart}`, `DTSTART:${dtstart}`, 'DURATION:PT1H', 'SUMMARY:From an app', 'ATTENDEE;CN=Grace:mailto:grace@example.invalid', 'X-CUSTOM:keep', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
    });
    expect(put.status).toBe(201);

    await nextWeek(page);
    await block(page, 'From an app').getByRole('button').click();
    await expect(sheet(page)).toContainText('Grace');
    await expect(sheet(page)).toContainText('Supercal doesn’t send invitations.');
    await sheet(page).getByRole('button', { name: 'Edit' }).click();
    await sheet(page).getByLabel('Title').fill('Renamed here');
    await sheet(page).getByRole('button', { name: 'Save' }).click();
    await expect(block(page, 'Renamed here')).toBeVisible();

    const stored = await (await fetch(object, { headers: { Authorization: authorization } })).text();
    expect(stored).toContain('SUMMARY:Renamed here');
    expect(stored).toContain('X-CUSTOM:keep');
    expect(stored).toContain('mailto:grace@example.invalid');
  });

  test('a stale edit fails with 412, keeps what was typed, and reloads', async ({ page }) => {
    const id = await openEvents(page, 'events-stale');
    await createEvent(page, 'Original', { weekly: false });

    await block(page, 'Original').getByRole('button').click();
    await sheet(page).getByRole('button', { name: 'Edit' }).click();
    await sheet(page).getByLabel('Title').fill('My typing');

    const [item] = await occurrences(page, id);
    const path = `/api/v1/calendars/${id}/events/${encodeURIComponent(item?.uid ?? '')}`;
    const current = await page.request.get(path);
    const behind = await page.request.patch(path, { headers: { 'If-Match': current.headers().etag ?? '' }, data: { title: 'Changed behind' } });
    expect(behind.status()).toBe(200);

    await sheet(page).getByRole('button', { name: 'Save' }).click();
    const conflict = sheet(page).getByRole('alert');
    await expect(conflict).toContainText('This event changed elsewhere');
    await expect(sheet(page).getByLabel('Title')).toHaveValue('My typing');
    expect((await occurrences(page, id))[0]?.title).toBe('Changed behind');

    await conflict.getByRole('button', { name: 'Reload' }).click();
    await expect(sheet(page).getByLabel('Title')).toHaveValue('Changed behind');
    await expect(conflict).toHaveCount(0);
  });
});
