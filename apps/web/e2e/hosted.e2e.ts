/**
 * Hosted calendars against a real daemon: the calendar's life from creation to restore, importing
 * and exporting a file, and a device login that really opens CalDAV.
 */
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
