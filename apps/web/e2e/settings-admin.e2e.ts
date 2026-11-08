/** Settings and tenant admin against the real daemon: ICS link rotation, API keys, and inviting a member. */
import { expect, request, test, type Page } from '@playwright/test';

const PASSWORD = 'correct-horse-battery';
const unique = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`;

async function signUp(page: Page, name: string, email = unique(name.split(' ')[0]?.toLowerCase() ?? 'user')) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  return email;
}

/** Rotates the default feed's ICS link from Settings and returns the combined URL from the one-time reveal. */
async function rotateIcsLink(page: Page) {
  const feed = page.getByRole('listitem', { name: 'My calendars' });
  await feed.getByRole('button', { name: 'Rotate ICS link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rotate link' }).click();
  const reveal = page.getByRole('dialog', { name: 'New ICS link' });
  const url = await reveal.getByRole('textbox', { name: 'Combined feed (https)' }).inputValue();
  await reveal.getByRole('button', { name: 'Done' }).click();
  return url;
}

test('rotating the ICS link retires the old URL', async ({ page }) => {
  await signUp(page, 'Rosa Rotate');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();

  const old = await rotateIcsLink(page);
  const fresh = await rotateIcsLink(page);
  expect(fresh).not.toBe(old);

  const anonymous = await request.newContext();
  expect((await anonymous.get(old)).status()).toBe(404);
  const current = await anonymous.get(fresh);
  expect(current.status()).toBe(200);
  expect(await current.text()).toContain('BEGIN:VCALENDAR');
  await anonymous.dispose();

  // The new token stays in memory, so the Subscribe screen shows the links without another rotation.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Subscribe' }).click();
  await page.getByRole('tab', { name: 'Any app (ICS)' }).click();
  await expect(page.getByRole('textbox', { name: 'All calendars (combined): https' })).toHaveValue(fresh);
});

test('an API key works until it is deleted', async ({ page }) => {
  const email = await signUp(page, 'Kai Keys');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();

  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('e2e');
  await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
  const reveal = page.getByRole('dialog', { name: 'API key “e2e”' });
  const key = await reveal.getByRole('textbox', { name: 'API key' }).inputValue();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await reveal.getByRole('button', { name: 'Copy API key' }).click();
  await expect(reveal.getByRole('button', { name: 'Copy API key' })).toContainText('Copied');
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(key);
  await reveal.getByRole('button', { name: 'Done' }).click();

  const api = await request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${key}` } });
  const me = await api.get('/api/v1/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ user: { email }, via: 'apiKey' });

  await page.getByRole('listitem', { name: 'e2e' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete key' }).click();
  // While a dialog is open the page behind it is hidden from the accessibility tree, so wait for the result.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('No API keys yet.')).toBeVisible();

  expect((await api.get('/api/v1/me')).status()).toBe(401);
  await api.dispose();
});

test('an invited member joins without the Admin menu', async ({ page }) => {
  await signUp(page, 'Olga Owner');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Admin' }).click();

  const memberEmail = unique('mia');
  await page.getByLabel('Invite by email').fill(memberEmail);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Invitation created' })).toBeVisible();
  const link = await page.getByRole('listitem', { name: `Invitation for ${memberEmail}` }).getByRole('textbox', { name: 'Invite link' }).inputValue();

  await page.getByRole('button', { name: 'Olga Owner', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.goto(link);
  await page.getByLabel('Name').fill('Mia Member');
  await page.getByLabel('Email').fill(memberEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account and join' }).click();

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Olga Owner.*Switch tenant/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);

  // The route is guarded too, not just hidden.
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
