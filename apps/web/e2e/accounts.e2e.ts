/**
 * Onboarding against a real daemon and sync worker: sign up, connect the ICS fixture from
 * `serve.ts`, watch its calendar appear and sync through the live stream (no reload), then find
 * the account active with a last-sync time on the Accounts screen.
 */
import { expect, test } from '@playwright/test';

const FIXTURE_URL = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT}/team.ics`;

test('sign up, connect an ICS link, watch its calendar appear, see the account active', async ({ page }) => {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(`onboarding-${Date.now()}@example.invalid`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();

  // No accounts yet, so Overview hands over to onboarding.
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { name: 'Connect your first calendar' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Google.*Not configured on this server/ })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Live');

  // Marks this document: it survives only if nothing reloads the page.
  await page.locator('html').evaluate((html) => html.setAttribute('data-e2e-session', 'kept'));

  await page.getByRole('button', { name: /ICS link/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect ICS link' });
  await dialog.getByLabel('Calendar link').fill(FIXTURE_URL);
  await dialog.getByLabel('Name (optional)').fill('Team feed');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('heading', { name: 'Calendar connected' })).toBeVisible();
  const calendars = page.getByRole('list', { name: 'Discovered calendars' });
  await expect(calendars.getByText('Team', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Publish Team' })).toBeChecked();
  // The worker's first sync arrives over the stream.
  await expect(calendars.getByText(/^synced /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Add it to your calendar app' })).toHaveAttribute('href', '/feeds/default/subscribe');
  await expect(page.locator('html')).toHaveAttribute('data-e2e-session', 'kept');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Accounts' }).click();
  const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Team feed' }) });
  await expect(row.getByText('Active')).toBeVisible();
  await expect(row).toContainText(/synced (just now|\d+ min ago) · .*1 calendar/);
  await expect(row).toContainText('ICS link · 127.0.0.1:');
});
