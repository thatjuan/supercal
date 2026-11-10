/** Browser enforcement of dashboard framing headers and rendering of the pinned API references. */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';

/** Create an account separately, then sign in through the dashboard to establish a browser session. */
async function signIn(page: Page, request: APIRequestContext) {
  const email = `browser-${crypto.randomUUID()}@example.invalid`;
  const password = 'correct-horse-battery';
  const created = await request.post('/api/auth/sign-up/email', { data: { email, password, name: 'Browser Test' } });
  expect(created.status()).toBe(200);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(await page.evaluate(async () => (await fetch('/api/v1/me')).status)).toBe(200);
}

test('another origin cannot frame a signed-in invitation', async ({ page, request }) => {
  await signIn(page, request);
  const origin = new URL(page.url()).origin;
  const invite = await page.request.post('/api/auth/organization/invite-member', {
    headers: { origin },
    data: { email: `invite-${crypto.randomUUID()}@example.invalid`, role: 'member' },
  });
  expect(invite.status()).toBe(200);
  const { id } = await invite.json() as { id: string };
  const target = `${origin}/invite/${id}`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Other origin</title><iframe src="${target}"></iframe>`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing attacker port');
    const refused = page.waitForEvent('console', { predicate: (message) => /frame-ancestors|X-Frame-Options/.test(message.text()) });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await refused;
    await expect.poll(() => page.frames().some((frame) => frame.url() === 'chrome-error://chromewebdata/')).toBe(true);
    await expect(page.frameLocator('iframe').getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

for (const [path, operation] of [['/api/docs', '/api/v1/me'], ['/api/auth/reference', '/sign-in/email']] as const) {
  test(`${path} renders operations with the pinned Scalar release`, async ({ page, request }) => {
    await signIn(page, request);
    await page.goto(path);
    await expect(page.locator('#app').getByText(operation, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('script[src]').evaluateAll((scripts) => scripts.map((script) => script.getAttribute('src'))))
      .toContain('https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0');
  });
}
