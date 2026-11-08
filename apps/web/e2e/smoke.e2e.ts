/** The first browser proof of same-origin cookie auth: sign up, use the shell (and its live stream), sign out, sign in. */
import { expect, test } from '@playwright/test';

test('sign up, land in the shell, sign out, sign in', async ({ page }) => {
  const email = `smoke-${Date.now()}@example.invalid`;
  const password = 'correct-horse-battery';

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);

  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Ada Lovelace.*Switch tenant/ })).toBeVisible();
  // The live stream authenticates with the same cookie.
  await expect(page.getByRole('status')).toHaveText('Live');

  await page.getByRole('button', { name: 'Ada Lovelace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
