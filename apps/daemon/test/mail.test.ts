/**
 * Transactional mail: the Resend request, and Better Auth sending verification, invitation,
 * magic-link and reset mail through a mailer (a scratch database, mail captured in memory).
 */
import { closeDb, connectDb, migrate } from '@supercal/db';
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

  test('sign-up mails a verification link; signing in waits for it, and the link verifies and signs in', async () => {
    const email = 'owner@example.invalid';
    expect((await call('/api/auth/sign-up/email', { email, password: 'correct-horse-battery', name: 'Owner' })).status).toBe(200);
    const { mail, url } = linkTo(email);
    expect(mail.subject).toBe('Confirm your email for Supercal');
    expect(url.pathname).toBe('/api/auth/verify-email');

    expect((await call('/api/auth/sign-in/email', { email, password: 'correct-horse-battery' })).status).toBe(403);
    const verified = await api.request(`${url.pathname}${url.search}`, { headers: { origin: TEST_ORIGIN } });
    expect(verified.status).toBe(302);
    const me = await call('/api/v1/me', undefined, cookieOf(verified));
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

  test('magic links and password resets are mailed; without a mailer magic links are off', async () => {
    expect((await call('/api/auth/sign-in/magic-link', { email: 'owner@example.invalid' })).status).toBe(200);
    expect(linkTo('owner@example.invalid')).toMatchObject({ mail: { subject: 'Sign in to Supercal' }, url: { pathname: '/api/auth/magic-link/verify' } });

    expect((await call('/api/auth/request-password-reset', { email: 'owner@example.invalid', redirectTo: '/' })).status).toBe(200);
    expect(linkTo('owner@example.invalid').mail.subject).toBe('Reset your Supercal password');

    expect((await call('/api/auth/sign-in/magic-link', { email: 'owner@example.invalid' }, undefined, apiWithoutMail)).status).toBe(404);
  });

  test('an operator’s reset link is handed back, not mailed', async () => {
    const before = sent.length;
    const link = await mailed.auth.passwordResetLink('owner@example.invalid');
    expect(new URL(link).pathname).toStartWith('/api/auth/reset-password/');
    expect(sent.length).toBe(before);
  });
});
