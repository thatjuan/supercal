/**
 * Transactional mail: the Resend request, and Better Auth sending verification, invitation,
 * and reset mail through a mailer (a scratch database, mail captured in memory).
 */
import { closeDb, connectDb, davLogin, feed, migrate } from '@supercal/db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { eq } from 'drizzle-orm';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createApi } from '../src/api/index.ts';
import { idleBus } from '../src/bus.ts';
import { createResendMailer, RESEND_URL, type Mail } from '../src/mail/index.ts';
import { TEST_ORIGIN, testAuth, testSecrets } from './auth-fixture.ts';

describe('Resend mailer', () => {
  test('posts the message to Resend with the API key', async () => {
    const requests: Request[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      requests.push(new Request(url, init));
      return Response.json({ id: 'msg_1' });
    };
    await createResendMailer({ apiKey: 're_test', from: 'Supercal <cal@example.com>', fetch }).send({
      to: 'ann@example.com',
      subject: 'Hi',
      text: 'Hello',
      html: '<p>Hello</p>',
    });
    const [request] = requests;
    expect(request?.url).toBe(RESEND_URL);
    expect(request?.headers.get('authorization')).toBe('Bearer re_test');
    expect(await request?.json()).toEqual({ from: 'Supercal <cal@example.com>', to: ['ann@example.com'], subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' });
  });

  test('a refused message throws with Resend’s reason', async () => {
    const fetch = async () => Response.json({ message: 'The domain is not verified' }, { status: 403 });
    const mailer = createResendMailer({ apiKey: 're_test', from: 'x@example.com', fetch });
    expect(mailer.send({ to: 'a@example.com', subject: 's', text: 't', html: 'h' })).rejects.toThrow('Resend refused the message (403): The domain is not verified');
  });
});

describe.skipIf(!testDatabaseUrl)('auth mail', () => {
  let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
  const sent: Mail[] = [];
  let mailed: ReturnType<typeof testAuth>;
  let unmailed: ReturnType<typeof testAuth>;
  let api: ReturnType<typeof createApi>;
  let apiWithoutMail: ReturnType<typeof createApi>;

  const call = (path: string, body?: unknown, cookie?: string, app = api) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json', ...(cookie && { cookie }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const cookieOf = (res: Response) => res.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  /** The one link in the last mail to `to`, checked to appear in both parts. */
  const linkTo = (to: string) => {
    const mail = sent.findLast((m) => m.to === to);
    const url = mail?.text.match(/https?:\/\/\S+/)?.[0];
    if (!mail || !url) throw new Error(`no mail with a link to ${to}`);
    expect(mail.html).toContain(url.replace(/&/g, '&#38;'));
    return { mail, url: new URL(url) };
  };

  beforeAll(async () => {
    scratch = await scratchDatabase('mail');
    await migrate(scratch.url);
    connectDb(scratch.url);
    mailed = testAuth('open', scratch.url, { send: async (mail) => void sent.push(mail) });
    unmailed = testAuth('open', scratch.url);
    api = createApi({ auth: mailed.auth, secrets: testSecrets, bus: idleBus });
    apiWithoutMail = createApi({ auth: unmailed.auth, secrets: testSecrets, bus: idleBus });
  });

  afterAll(async () => {
    await mailed.close();
    await unmailed.close();
    await closeDb();
    await scratch.drop();
  });

  test('same-browser verification keeps the password and sets no session cookie', async () => {
    const email = 'owner@example.invalid';
    const registered = await call('/api/auth/sign-up/email', { email, password: 'correct-horse-battery', name: 'Owner' });
    expect(registered.status).toBe(200);
    const proof = registered.headers.getSetCookie().find((line) => line.startsWith('supercal_signup='));
    expect(proof).toContain('HttpOnly');
    expect(proof).toContain('SameSite=Lax');
    expect(proof).toContain('Path=/api/auth');
    expect(proof).toContain('Max-Age=86400');
    const { mail, url } = linkTo(email);
    expect(mail.subject).toBe('Confirm your email for Supercal');
    expect(url.pathname).toBe('/api/auth/verify-email');

    expect((await call('/api/auth/sign-in/email', { email, password: 'correct-horse-battery' })).status).toBe(403);
    const verified = await api.request(`${url.pathname}${url.search}`, { headers: { origin: TEST_ORIGIN, cookie: cookieOf(registered) } });
    expect(verified.status).toBe(302);
    expect(verified.headers.getSetCookie()).toEqual([]);
    const signedIn = await call('/api/auth/sign-in/email', { email, password: 'correct-horse-battery' });
    expect(signedIn.status).toBe(200);
    const me = await call('/api/v1/me', undefined, cookieOf(signedIn));
    expect(me.status).toBe(200);
  });

  test('an invitation mails a link to the dashboard’s invitation page', async () => {
    const signedIn = await call('/api/auth/sign-in/email', { email: 'owner@example.invalid', password: 'correct-horse-battery' });
    const invite = await call('/api/auth/organization/invite-member', { email: 'guest@example.invalid', role: 'member' }, cookieOf(signedIn));
    expect(invite.status).toBe(200);
    const { id } = (await invite.json()) as { id: string };
    const { mail, url } = linkTo('guest@example.invalid');
    expect(mail.subject).toBe('Owner invited you to Owner on Supercal');
    expect(url.href).toBe(`${TEST_ORIGIN}/invite/${id}`);
  });

  test('the removed magic-link endpoint answers 404 with or without mail', async () => {
    for (const app of [api, apiWithoutMail]) {
      expect((await call('/api/auth/sign-in/magic-link', { email: 'owner@example.invalid' }, undefined, app)).status).toBe(404);
    }
  });

  test('another browser discards the unproven password and sessions; recovery creates a password', async () => {
    const email = 'cross-browser@example.invalid';
    const registered = await call('/api/auth/sign-up/email', { email, password: 'registrant-password', name: 'Mailbox holder' });
    expect(registered.status).toBe(200);
    const { url } = linkTo(email);
    const duplicate = await call('/api/auth/sign-up/email', { email, password: 'second-password', name: 'Second registrant' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.headers.getSetCookie().some((line) => line.startsWith('supercal_signup='))).toBe(false);
    const attacker = await call('/api/auth/sign-in/email', { email, password: 'registrant-password' }, undefined, apiWithoutMail);
    expect(attacker.status).toBe(200);
    const verified = await api.request(`${url.pathname}${url.search}`, { headers: { 'sec-fetch-site': 'cross-site', referer: 'https://attacker.invalid/' } });
    expect(verified.status).toBe(302);
    expect(verified.headers.getSetCookie()).toEqual([]);
    expect((await call('/api/v1/me', undefined, cookieOf(attacker))).status).toBe(401);
    expect((await call('/api/auth/sign-in/email', { email, password: 'registrant-password' })).status).toBe(401);
    const reset = new URL(await mailed.auth.passwordResetLink(email));
    expect((await call('/api/auth/reset-password', { token: reset.pathname.split('/').at(-1), newPassword: 'mailbox-holder-password' })).status).toBe(200);
    expect((await call('/api/auth/sign-in/email', { email, password: 'mailbox-holder-password' })).status).toBe(200);
  });

  test('password recovery revokes sessions, API keys, device logins and sibling tokens, preserving feeds', async () => {
    const email = 'owner@example.invalid';
    const signedIn = await call('/api/auth/sign-in/email', { email, password: 'correct-horse-battery' });
    const cookie = cookieOf(signedIn);
    const me = await (await call('/api/v1/me', undefined, cookie)).json() as { user: { id: string } };
    const keyResponse = await call('/api/v1/api-keys', { name: 'Recovery test' }, cookie);
    expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json() as { key: string };
    expect((await api.request('/api/v1/me', { headers: { authorization: `Bearer ${key.key}` } })).status).toBe(200);
    const device = await call('/api/v1/dav-logins', { name: 'Phone' }, cookie);
    expect(device.status).toBe(201);
    const createdFeed = await call('/api/v1/feeds', { name: 'Read-only recovery feed' }, cookie);
    expect(createdFeed.status).toBe(201);
    const feedsBefore = await unsafeDb().select().from(feed);
    const sibling = new URL(await mailed.auth.passwordResetLink(email));
    expect((await call('/api/auth/request-password-reset', { email, redirectTo: '/' })).status).toBe(200);
    const { mail, url } = linkTo(email);
    expect(mail.subject).toBe('Reset your Supercal password');
    expect((await call('/api/auth/reset-password', { token: url.pathname.split('/').at(-1), newPassword: 'recovered-password' })).status).toBe(200);
    expect((await call('/api/v1/me', undefined, cookie)).status).toBe(401);
    expect((await api.request('/api/v1/me', { headers: { authorization: `Bearer ${key.key}` } })).status).toBe(401);
    expect(await unsafeDb().select().from(davLogin).where(eq(davLogin.userId, me.user.id))).toHaveLength(0);
    expect(await unsafeDb().select().from(feed)).toEqual(feedsBefore);
    expect((await call('/api/auth/reset-password', { token: sibling.pathname.split('/').at(-1), newPassword: 'stolen-password' })).status).toBe(400);
    expect((await call('/api/auth/sign-in/email', { email, password: 'recovered-password' })).status).toBe(200);
  });

  test('reset requests do not wait for mail delivery; handed-out links remain synchronous', async () => {
    const deliveries: Promise<void>[] = [];
    const slow = testAuth('open', scratch.url, { send: async () => {
      const delivery = Bun.sleep(300);
      deliveries.push(delivery);
      await delivery;
    } });
    try {
      const app = createApi({ auth: slow.auth, secrets: testSecrets, bus: idleBus });
      const start = performance.now();
      expect((await call('/api/auth/request-password-reset', { email: 'owner@example.invalid' }, undefined, app)).status).toBe(200);
      expect(performance.now() - start).toBeLessThan(100);
      expect(new URL(await slow.auth.passwordResetLink('owner@example.invalid')).pathname).toStartWith('/api/auth/reset-password/');
    } finally {
      await Promise.all(deliveries);
      await slow.close();
    }
  });

  test('an operator’s reset link is handed back, not mailed', async () => {
    const before = sent.length;
    const link = await mailed.auth.passwordResetLink('owner@example.invalid');
    expect(new URL(link).pathname).toStartWith('/api/auth/reset-password/');
    expect(sent.length).toBe(before);
  });
});
