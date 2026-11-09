/**
 * Hosted calendars against a real daemon: the calendar's life from creation to restore, importing
 * and exporting a file, a device login that really opens CalDAV, sharing with a second member, and
 * a published link from creation to revocation.
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

const nav = (page: Page, name: 'Admin' | 'Calendars' | 'Hosted' | 'Settings') => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();

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

test('a shared calendar reaches a second member, who cannot manage its sharing', async ({ page, browser, baseURL }) => {
  await signUp(page, 'hosted-owner');
  await nav(page, 'Admin');
  const memberEmail = `hosted-member-${Date.now()}@example.invalid`;
  await page.getByLabel('Invite by email').fill(memberEmail);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const invite = await page.getByRole('listitem', { name: `Invitation for ${memberEmail}` }).getByRole('textbox', { name: 'Invite link' }).inputValue();

  const memberContext = await browser.newContext({ baseURL: baseURL ?? '' });
  const member = await memberContext.newPage();
  await member.goto(invite);
  await member.getByLabel('Name').fill('Mia Member');
  await member.getByLabel('Email').fill(memberEmail);
  await member.getByLabel('Password').fill('correct-horse-battery');
  await member.getByRole('button', { name: 'Create account and join' }).click();
  await expect(member).toHaveURL(/\/welcome$/);

  await createCalendar(page, 'Shared plans');
  await page.getByRole('tab', { name: 'Sharing' }).click();
  await page.getByRole('combobox', { name: 'Share with' }).selectOption({ label: `Mia Member (${memberEmail})` });
  await page.getByRole('combobox', { name: 'Access', exact: true }).selectOption({ label: 'See events' });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('listitem', { name: 'Mia Member' }).getByRole('combobox')).toHaveValue('read');

  await nav(member, 'Hosted');
  await member.getByRole('region', { name: 'Shared with you' }).getByRole('link', { name: 'Shared plans' }).click();
  await expect(member.getByRole('heading', { name: 'Shared plans', level: 1 })).toBeVisible();
  await expect(member.getByRole('tab', { name: 'Availability' })).toBeVisible();
  await expect(member.getByRole('tab', { name: 'Settings' })).toBeVisible();
  await expect(member.getByRole('tab', { name: 'Sharing' })).toHaveCount(0);
  await expect(member.getByRole('tab', { name: 'Links' })).toHaveCount(0);
  await memberContext.close();
});

test('a busy-only link publishes busy time without attendees, until it is revoked', async ({ page }) => {
  await signUp(page, 'hosted-link');
  await createCalendar(page, 'Published');

  const start = new Date(Date.now() + 86_400_000);
  const body = ics('Source', [{ uid: 'secret@e2e', summary: 'Secret plans', start, minutes: 60 }]).replace('END:VEVENT', 'ATTENDEE:mailto:guest@example.invalid\r\nEND:VEVENT');
  await page.getByLabel('Calendar file').setInputFiles({ name: 'source.ics', mimeType: 'text/calendar', buffer: Buffer.from(body) });
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 created' })).toBeVisible();

  await page.getByRole('tab', { name: 'Links' }).click();
  await page.getByRole('button', { name: 'New link' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name (optional)').fill('Website');
  await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await dialog.getByRole('radio', { name: /Busy only/ }).check();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  const reveal = page.getByRole('dialog', { name: 'Link “Website”' });
  const url = await reveal.getByLabel('Subscribe URL', { exact: true }).inputValue();
  await expect(reveal.getByLabel('Calendar app URL', { exact: true })).toHaveValue(/^webcal:/);
  await reveal.getByRole('button', { name: 'Done' }).click();

  const published = await fetch(url);
  expect(published.status).toBe(200);
  expect(published.headers.get('content-type')).toContain('text/calendar');
  const calendar = await published.text();
  expect(calendar).toContain('SUMMARY:Busy');
  expect(calendar).not.toContain('Secret plans');
  expect(calendar).not.toContain('guest@example.invalid');

  const row = page.getByRole('listitem', { name: 'Website' });
  await expect(row).toContainText('No expiry');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('dialog')).toContainText('lose access at once');
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke link' }).click();
  await expect(page.getByText('No published links yet.')).toBeVisible();
  expect((await fetch(url)).status).toBe(404);
});
