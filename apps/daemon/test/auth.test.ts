/**
 * Authentication end to end over a fresh scratch database: sign-up modes, the principal resolver
 * (sessions and tenant-bound API keys), role policy and the operator's tenant endpoint. Ports the
 * scenarios of `spikes/platform/src/auth-evidence.ts`.
 */
import { apiKeyTenant, closeDb, connectDb, member, migrate } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createApi } from '../src/api/index.ts';
import type { AuthConfig } from '../src/auth/auth.ts';
import { TEST_ORIGIN, testAuth } from './auth-fixture.ts';

type Mode = AuthConfig['SUPERCAL_SIGNUP'];
type Me = { user: { id: string; email: string }; tenant: { id: string }; role: string; isOperator: boolean; via: string; tenants: { id: string }[] };
type Request = { body?: unknown; cookie?: string; key?: string; method?: string };

let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
const fixtures: ReturnType<typeof testAuth>[] = [];
const apps = new Map<Mode, ReturnType<typeof createApi>>();

/** Sends a request to the daemon API built for sign-up `mode`. */
function call(mode: Mode, path: string, { body, cookie, key, method }: Request = {}) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN, 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (key) headers.authorization = `Bearer ${key}`;
  const app = apps.get(mode);
  if (!app) throw new Error(`no app for ${mode}`);
  return app.request(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const cookieOf = (res: Response) => res.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');

let counter = 0;
/** Signs up a fresh user through Better Auth; returns the response and its session cookie. */
async function signUp(mode: Mode, extra: Record<string, unknown> = {}) {
  const email = `user${++counter}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
  const res = await call(mode, '/api/auth/sign-up/email', { body: { email, password: 'correct-horse-battery', name: `User ${counter}`, ...extra } });
  return { res, email, cookie: cookieOf(res) };
}

async function me(mode: Mode, auth: { cookie?: string; key?: string }) {
  const res = await call(mode, '/api/v1/me', auth);
  return { status: res.status, body: (await res.json()) as Me };
}

const setRole = (userId: string, tenantId: string, role: string) =>
  unsafeDb().update(member).set({ role }).where(and(eq(member.userId, userId), eq(member.organizationId, tenantId)));

describe.skipIf(!testDatabaseUrl)('authentication', () => {
  let operator: { cookie: string; me: Me };

  beforeAll(async () => {
    scratch = await scratchDatabase('auth');
    await migrate(scratch.url);
    connectDb(scratch.url);
    for (const mode of ['open', 'invite', 'disabled'] as const) {
      const fixture = testAuth(mode, scratch.url);
      fixtures.push(fixture);
      apps.set(mode, createApi(fixture.auth));
    }
  });

  afterAll(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
    await closeDb();
    await scratch?.drop();
  });

  describe('invite mode', () => {
    test('the first user of an empty install signs up, becomes operator and owns a tenant', async () => {
      const { res, cookie } = await signUp('invite');
      expect(res.status).toBe(200);
      const { status, body } = await me('invite', { cookie });
      expect(status).toBe(200);
      expect(body).toMatchObject({ role: 'owner', isOperator: true, via: 'session' });
      operator = { cookie, me: body };
    });

    test('later sign-ups need a pending invitation for the same email', async () => {
      expect((await signUp('invite')).res.status).toBe(403);
      expect((await signUp('invite', { invitationId: 'made-up' })).res.status).toBe(403);

      const email = `invitee-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
      const invite = await call('invite', '/api/auth/organization/invite-member', { cookie: operator.cookie, body: { email, role: 'member' } });
      expect(invite.status).toBe(200);
      const { id: invitationId } = (await invite.json()) as { id: string };
      const res = await call('invite', '/api/auth/sign-up/email', { body: { email, password: 'correct-horse-battery', name: 'Invitee', invitationId } });
      expect(res.status).toBe(200);
      const cookie = cookieOf(res);

      // Signed up but not yet a member anywhere: no tenant to act in.
      const before = await call('invite', '/api/v1/me', { cookie });
      expect(before.status).toBe(403);
      expect(await before.json()).toMatchObject({ type: 'https://supercal.dev/problems/no-active-tenant' });

      const accept = await call('invite', '/api/auth/organization/accept-invitation', { cookie, body: { invitationId } });
      expect(accept.status).toBe(200);
      expect((await me('invite', { cookie: cookieOf(accept) || cookie })).body).toMatchObject({ role: 'member', tenant: { id: operator.me.tenant.id } });
    });
  });

  describe('open mode, sessions and API keys', () => {
    let user: { cookie: string; me: Me };
    let key: { id: string; key: string };

    test('sign-up creates a personal tenant the user owns, and GET /me works by cookie', async () => {
      const { res, cookie } = await signUp('open');
      expect(res.status).toBe(200);
      const { status, body } = await me('open', { cookie });
      expect(status).toBe(200);
      expect(body).toMatchObject({ role: 'owner', isOperator: false, via: 'session' });
      expect(body.tenants.map((tenant) => tenant.id)).toEqual([body.tenant.id]);
      user = { cookie, me: body };
    });

    test('an issued key resolves to the same user and tenant', async () => {
      const res = await call('open', '/api/v1/api-keys', { cookie: user.cookie, body: { name: 'CI', expiresInDays: 30 } });
      expect(res.status).toBe(201);
      key = (await res.json()) as { id: string; key: string };
      const { status, body } = await me('open', { key: key.key });
      expect(status).toBe(200);
      expect(body).toMatchObject({ via: 'apiKey', role: 'owner', user: { id: user.me.user.id }, tenant: { id: user.me.tenant.id } });

      const list = (await (await call('open', '/api/v1/api-keys', { key: key.key })).json()) as { items: { id: string }[] };
      expect(list.items.map((item) => item.id)).toEqual([key.id]);
    });

    test('editing key metadata through Better Auth does not move the key to another tenant', async () => {
      const update = await call('open', '/api/auth/api-key/update', { cookie: user.cookie, body: { keyId: key.id, metadata: { tenantId: operator.me.tenant.id } } });
      expect(update.status).toBe(200);
      expect((await me('open', { key: key.key })).body.tenant.id).toBe(user.me.tenant.id);
    });

    test('an invalid key is a 401 even beside a valid cookie', async () => {
      expect((await call('open', '/api/v1/me', { key: `${key.key}x`, cookie: user.cookie })).status).toBe(401);
    });

    test('Better Auth’s own key-create endpoint is closed to clients', async () => {
      const res = await call('open', '/api/auth/api-key/create', { cookie: user.cookie, body: { name: 'sneaky' } });
      expect(res.status).toBe(404);
      const bound = await unsafeDb().select().from(apiKeyTenant).where(eq(apiKeyTenant.userId, user.me.user.id));
      expect(bound).toHaveLength(1);
    });

    test('member, admin and owner each resolve, and requireRole("admin") rejects a member', async () => {
      const { user: { id: userId }, tenant: { id: tenantId } } = user.me;
      for (const role of ['member', 'admin', 'owner']) {
        await setRole(userId, tenantId, role);
        expect((await me('open', { cookie: user.cookie })).body.role).toBe(role);
      }
      await setRole(userId, tenantId, 'member');
      const res = await call('open', '/api/v1/audit-log', { key: key.key });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ type: 'https://supercal.dev/problems/forbidden' });
      await setRole(userId, tenantId, 'admin');
      const entries = (await (await call('open', '/api/v1/audit-log', { key: key.key })).json()) as { items: { action: string }[] };
      expect(entries.items.map((entry) => entry.action)).toContain('api_key.create');
      await setRole(userId, tenantId, 'owner');
    });

    test('a key stops working as soon as its user leaves the tenant', async () => {
      const { user: { id: userId }, tenant: { id: tenantId } } = user.me;
      await unsafeDb().delete(member).where(and(eq(member.userId, userId), eq(member.organizationId, tenantId)));
      expect((await me('open', { key: key.key })).status).toBe(401);
    });
  });

  describe('disabled mode', () => {
    test('nobody signs up', async () => {
      expect((await signUp('disabled')).res.status).toBe(403);
    });

    test('the operator creates a tenant with a new owner, who gets a one-time reset link', async () => {
      const ownerEmail = `owner-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
      const res = await call('disabled', '/api/v1/tenants', { cookie: operator.cookie, body: { name: 'Acme', ownerEmail } });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { tenant: { id: string; slug: string }; owner: { id: string; email: string }; passwordResetUrl: string };
      expect(created.owner.email).toBe(ownerEmail);
      expect(created.passwordResetUrl).toStartWith(`${TEST_ORIGIN}/api/auth/reset-password/`);
      const [membership] = await unsafeDb().select().from(member).where(eq(member.organizationId, created.tenant.id));
      expect(membership).toMatchObject({ userId: created.owner.id, role: 'owner' });

      const tenants = (await (await call('disabled', '/api/v1/tenants', { cookie: operator.cookie })).json()) as { items: { id: string }[] };
      expect(tenants.items.map((tenant) => tenant.id)).toContain(created.tenant.id);
      const taken = await call('disabled', '/api/v1/tenants', { cookie: operator.cookie, body: { name: 'Acme again', slug: created.tenant.slug } });
      expect(taken.status).toBe(409);
    });

    test('tenant endpoints need the operator', async () => {
      const { cookie } = await signUp('open');
      expect((await call('disabled', '/api/v1/tenants', { cookie, body: { name: 'Nope' } })).status).toBe(403);
    });
  });

  describe('current tenant', () => {
    test('an owner renames it and the change is audited', async () => {
      const res = await call('open', '/api/v1/tenant', { cookie: operator.cookie, method: 'PATCH', body: { name: 'Operations' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: operator.me.tenant.id, name: 'Operations' });
      const entries = (await (await call('open', '/api/v1/audit-log', { cookie: operator.cookie })).json()) as { items: { action: string }[] };
      expect(entries.items.map((entry) => entry.action)).toContain('tenant.update');
    });
  });
});
