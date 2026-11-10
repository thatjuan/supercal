/**
 * Sign-up on a production-shaped install: `invite` mode with mail on, against a daemon of its own
 * (`serve-verified.ts`). The first user becomes the operator after confirming and signing in, and an
 * invitee confirms and then accepts. The links come from the mail the daemon really produced.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PASSWORD = 'correct-horse-battery';
const OWNER = 'owner@example.invalid';
const INVITEE = 'invitee@example.invalid';

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_VERIFIED_PORT}` });
test.describe.configure({ mode: 'serial' });

const mailLog = process.env.E2E_MAIL_LOG ?? '';

type CapturedMail = { to: string[]; subject: string; text: string };

/** The link in the newest captured mail to `to` whose subject has `subject`, waiting for it to arrive. */
async function mailedLink(to: string, subject: string) {
  const find = () =>
    readFileSync(mailLog, { encoding: 'utf8', flag: 'a+' })
      .split('\n')
      .filter(Boolean)
      .map((line): CapturedMail => JSON.parse(line))
      .findLast((mail) => mail.to.includes(to) && mail.subject.includes(subject))
      ?.text.match(/https?:\/\/\S+/)?.[0];
  await expect.poll(find).toBeTruthy();
  return find() ?? '';
}

async function fillSignUp(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
}

const notice = (page: Page, email: string) => page.getByRole('status').filter({ hasText: email });

test('the first user confirms by email, then signs in to their tenant as operator', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Set up Supercal' })).toBeVisible();
  await fillSignUp(page, 'Olga Owner', OWNER);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(notice(page, OWNER)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-up$/);

  await page.goto(await mailedLink(OWNER, 'Confirm your email'));
  await expect(page).toHaveURL(/\/sign-in\?verified=1$/);
  await expect(page.getByRole('status')).toHaveText('Your email is confirmed. Sign in, or reset your password if you opened the link on another device.');
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { name: 'No tenant yet' })).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Operator' })).toBeVisible();

  const me = await page.request.get('/api/v1/me');
  expect(await me.json()).toMatchObject({ role: 'owner', isOperator: true, tenant: { name: 'Olga Owner' } });
});

test('an invitee confirms by email and accepts the invitation', async ({ page, browser }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' }).click();
  await page.getByLabel('Invite by email').fill(INVITEE);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Invitation created' })).toBeVisible();

  const context = await browser.newContext();
  const invitee = await context.newPage();
  const invitation = await mailedLink(INVITEE, 'invited you');
  await invitee.goto(invitation);
  await fillSignUp(invitee, 'Mia Member', INVITEE);
  await invitee.getByRole('button', { name: 'Create account and join' }).click();

  await expect(invitee.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(notice(invitee, INVITEE)).toBeVisible();

  await invitee.goto(await mailedLink(INVITEE, 'Confirm your email'));
  await expect(invitee).toHaveURL(invitation);
  await invitee.getByRole('link', { name: 'Sign in to accept' }).click();
  await expect(invitee.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await invitee.getByLabel('Email').fill(INVITEE);
  await invitee.getByLabel('Password').fill(PASSWORD);
  await invitee.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(invitee).toHaveURL(invitation);
  await invitee.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(invitee).toHaveURL(/\/welcome$/);
  await expect(invitee.getByRole('button', { name: /Olga Owner.*Switch tenant/ })).toBeVisible();
  await context.close();
});

test('an operator explicitly confirms assigning an unverified owner', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(OWNER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  const ownerEmail = 'unverified-owner@example.invalid';
  const seed = await page.request.post('/api/v1/tenants', {
    headers: { origin: new URL(page.url()).origin },
    data: { name: 'First unverified tenant', ownerEmail },
  });
  expect(seed.status()).toBe(201);
  await page.goto('/operator');
  await page.getByLabel('Name', { exact: true }).fill('Confirmed assignment');
  await page.getByLabel('Owner email').fill(ownerEmail);
  await page.getByRole('button', { name: 'Create tenant', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('An unverified account holds that email');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Assign anyway' }).click();
  await expect(page.getByRole('region', { name: 'New tenant' }).getByRole('status')).toContainText(`Created Confirmed assignment, owned by ${ownerEmail}`);
});
