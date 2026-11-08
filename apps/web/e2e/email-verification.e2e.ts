/**
 * Sign-up on a production-shaped install: `invite` mode with mail on, against a daemon of its own
 * (`serve-verified.ts`). The first user becomes the operator through the confirmation link, and an
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

test('the first user confirms by email and lands on their tenant as operator', async ({ page }) => {
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Set up Supercal' })).toBeVisible();
  await fillSignUp(page, 'Olga Owner', OWNER);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(notice(page, OWNER)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-up$/);

  await page.goto(await mailedLink(OWNER, 'Confirm your email'));
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
  await invitee.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(invitee).toHaveURL(/\/welcome$/);
  await expect(invitee.getByRole('button', { name: /Olga Owner.*Switch tenant/ })).toBeVisible();
  await context.close();
});
