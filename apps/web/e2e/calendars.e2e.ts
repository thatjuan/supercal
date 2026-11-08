/**
 * Calendars, virtual calendars and the preview against a real daemon syncing two ICS accounts
 * from fixtures: merge them, switch the merge to busy-only, publish and hide a calendar, and watch a
 * source change arrive in the preview without a reload.
 */
import { expect, test, type Page } from '@playwright/test';
import { fixtureOrigin, ics, type FixtureEvent } from './fixture.ts';

// Fixture events sit on today's date in UTC, so the preview (this week, browser zone) shows them.
test.use({ timezoneId: 'UTC' });

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const at = (hour: number) => new Date(today.getTime() + hour * 3_600_000);

const teamSync: FixtureEvent = { uid: 'team-sync@e2e', summary: 'Team sync', start: at(11), minutes: 60, location: 'Room 4B' };
const standup: FixtureEvent = { uid: 'standup@e2e', summary: 'Standup', start: at(9), minutes: 30 };
const dentist: FixtureEvent = { uid: 'dentist@e2e', summary: 'Dentist', start: at(14), minutes: 60 };

const putFixture = async (name: string, body: string) => {
  const response = await fetch(`${fixtureOrigin()}/${name}`, { method: 'PUT', body });
  expect(response.ok).toBe(true);
};

/** Calls the API from the page, so the session cookie and Origin apply. */
const api = (page: Page, path: string, init: { method: string; body?: unknown }) =>
  page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, { method: init.method, headers: { 'content-type': 'application/json' }, body: init.body === undefined ? null : JSON.stringify(init.body) });
      return { status: response.status, body: (await response.json().catch(() => null)) as { account?: { id: string } } | null };
    },
    { path, init },
  );

async function signUp(page: Page) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(`calendars-${Date.now()}@example.invalid`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  // No accounts yet, so the app lands on onboarding.
  await expect(page).toHaveURL(/\/welcome$/);
}

const nav = (page: Page, name: 'Calendars' | 'Preview') => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
const timed = (page: Page, summary: string) => page.getByTestId('timed-event').filter({ hasText: summary });

test('merge two ICS calendars, make it busy-only, toggle a calendar, see a live change', async ({ page }) => {
  test.setTimeout(120_000);
  await putFixture('work.ics', ics('Work', [standup, teamSync]));
  await putFixture('home.ics', ics('Home', [dentist, teamSync]));
  await signUp(page);

  const work = await api(page, '/api/v1/accounts', { method: 'POST', body: { provider: 'ics', url: `${fixtureOrigin()}/work.ics`, displayName: 'Work feed' } });
  const home = await api(page, '/api/v1/accounts', { method: 'POST', body: { provider: 'ics', url: `${fixtureOrigin()}/home.ics`, displayName: 'Home feed' } });
  expect([work.status, home.status]).toEqual([201, 201]);
  const workAccount = work.body?.account?.id;

  // Build a virtual calendar over both, hiding the individual calendars.
  await nav(page, 'Calendars');
  await expect(page.getByRole('heading', { name: 'Calendars (2)' })).toBeVisible();
  await page.getByRole('link', { name: 'New virtual calendar' }).click();
  await page.getByRole('checkbox', { name: 'Work' }).check();
  await page.getByRole('button', { name: 'Create virtual calendar' }).click();
  await expect(page.getByText('Pick at least two calendars to merge')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Home' }).check();
  await page.getByLabel('Name').fill('Work+Home');
  await page.getByRole('checkbox', { name: 'Also hide the individual calendars' }).check();
  await page.getByRole('button', { name: 'Create virtual calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Calendars (2)' })).toBeVisible();
  await expect(page.getByText('in: Work+Home')).toHaveCount(2);
  await expect(page.getByRole('switch', { name: 'Publish Work', exact: true })).not.toBeChecked();

  // The preview shows the merge: the shared event once, each calendar's own event.
  await nav(page, 'Preview');
  await expect(page.getByRole('list', { name: 'Publications' }).getByRole('button')).toHaveText(['Work+Home']);
  await expect(timed(page, 'Standup')).toHaveCount(1, { timeout: 30_000 });
  await expect(timed(page, 'Dentist')).toHaveCount(1, { timeout: 30_000 });
  await expect(timed(page, 'Team sync')).toHaveCount(1);

  // Busy-only: every title becomes "Busy".
  await nav(page, 'Calendars');
  await page.getByRole('link', { name: /Work\+Home/ }).click();
  await page.getByRole('radio', { name: /Busy only/ }).check();
  await expect(page.getByRole('note')).toHaveText('Calendar apps will re-download this calendar');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Calendars (2)' })).toBeVisible();
  await nav(page, 'Preview');
  await expect(timed(page, 'Busy')).toHaveCount(3);
  await expect(timed(page, 'Standup')).toHaveCount(0);

  // Publish Work on its own: its titles show again; a source change arrives live.
  await nav(page, 'Calendars');
  await page.getByRole('switch', { name: 'Publish Work', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Publish Work', exact: true })).toBeChecked();
  await nav(page, 'Preview');
  await expect(timed(page, 'Standup')).toHaveCount(1);

  await putFixture('work.ics', ics('Work', [{ ...standup, summary: 'Standup (moved)', start: at(15) }, teamSync]));
  expect((await api(page, `/api/v1/accounts/${workAccount}/sync`, { method: 'POST' })).status).toBeLessThan(300);
  await expect(timed(page, 'Standup (moved)')).toHaveCount(1, { timeout: 30_000 });

  // Toggle Work off again: it leaves the preview.
  await nav(page, 'Calendars');
  await page.getByRole('switch', { name: 'Publish Work', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Publish Work', exact: true })).not.toBeChecked();
  await nav(page, 'Preview');
  await expect(page.getByRole('list', { name: 'Publications' }).getByRole('button')).toHaveText(['Work+Home']);
  await expect(timed(page, 'Standup (moved)')).toHaveCount(0);
  await expect(timed(page, 'Busy')).toHaveCount(3);
});
