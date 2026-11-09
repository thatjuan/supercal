/**
 * Authentication end to end over a fresh scratch database: sign-up modes, the principal resolver
 * (sessions and tenant-bound API keys), role policy and the operator's tenant endpoint. Ports the
 * scenarios of `spikes/platform/src/auth-evidence.ts`.
 */
import { apiKeyTenant, closeDb, connectDb, createControlDatabase, member, migrate, user } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { createApi } from '../src/api/index.ts';
import { idleBus } from '../src/bus.ts';
import { createAuth, type AuthConfig } from '../src/auth/auth.ts';
import { TEST_ORIGIN, testAuth, testSecrets } from './auth-fixture.ts';

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
      apps.set(mode, createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus }));
    }
  });

  afterAll(async () => {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
    await closeDb();
    await scratch?.drop();
  });

  test('secure-mode sign-in limits use the configured client IP with NODE_ENV unset and ignore forged private headers', async () => {
    if (!scratch) throw new Error('auth database missing');
    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const db = createControlDatabase(scratch.url, 2);
    try {
      const origin = 'https://cal.example.test';
      const auth = createAuth({
        PORT: 4316,
        SUPERCAL_PUBLIC_URL: origin,
        SUPERCAL_SIGNUP: 'invite',
        SUPERCAL_INSECURE_DEV: false,
        BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
        WEB_ORIGIN: undefined,
      }, db);
      const app = createApi({ auth, secrets: testSecrets, bus: idleBus, clientIpHeader: 'X-Forwarded-For' });
      const signIn = (ip: string, forged: string) => app.request(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'X-Forwarded-For': `198.51.100.1, ${ip}`, 'x-supercal-client-ip': forged },
        body: JSON.stringify({ email: 'missing@example.invalid', password: 'wrong-password' }),
      });
      for (let i = 0; i < 3; i++) expect((await signIn('192.0.2.1', `203.0.113.${i + 1}`)).status).toBe(401);
      const limited = await signIn('192.0.2.1', '203.0.113.99');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('X-Retry-After'))).toBeGreaterThan(0);
      // Sharing the forged address does not put a different resolved client into the blocked bucket.
      expect((await signIn('192.0.2.2', '203.0.113.99')).status).toBe(401);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      await db.$client.end();
    }
  });

  test('an oversized sign-in body is rejected before Better Auth sees it', async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error('auth fixture missing');
    const handler = spyOn(fixture.auth, 'handler');
    try {
      const res = await call('open', '/api/auth/sign-in/email', { body: { email: 'user@example.test', password: 'x'.repeat(1024 * 1024) } });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ message: 'Request body too large' });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      handler.mockRestore();
    }
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

    test('cookie mutations check origins and fetch metadata while bearer clients may cross origins', async () => {
      const app = apps.get('open');
      if (!app) throw new Error('open app missing');
      const feeds = await call('open', '/api/v1/feeds', { cookie: user.cookie });
      const { items } = await feeds.json() as { items: { id: string }[] };
      const feed = items[0];
      if (!feed) throw new Error('default feed missing');
      const path = `/api/v1/feeds/${feed.id}/credentials/ics/rotate`;
      for (const origin of ['http://sibling.localhost:4316', 'https://foreign.example']) {
        const res = await app.request(path, { method: 'POST', headers: { cookie: user.cookie, origin } });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ type: 'https://supercal.dev/problems/cross-origin' });
      }
      expect((await app.request(path, { method: 'POST', headers: { cookie: user.cookie, origin: TEST_ORIGIN } })).status).toBe(200);
      expect((await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key.key}`, origin: 'https://foreign.example' } })).status).toBe(200);
      for (const site of ['same-site', 'cross-site'])
        expect((await app.request(path, { method: 'POST', headers: { cookie: user.cookie, 'Sec-Fetch-Site': site } })).status).toBe(403);
      for (const site of ['same-origin', 'none'])
        expect((await app.request(path, { method: 'POST', headers: { cookie: user.cookie, 'Sec-Fetch-Site': site } })).status).toBe(200);
      expect((await app.request(path, { method: 'POST', headers: { cookie: user.cookie } })).status).toBe(200);

      const profile = `/api/v1/feeds/${feed.id}/mobileconfig`;
      expect((await app.request(profile, { headers: { cookie: user.cookie, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
      expect((await app.request(profile, { headers: { cookie: user.cookie, 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
      expect((await app.request(profile, { headers: { authorization: `Bearer ${key.key}`, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(200);
    });

    test('Better Auth key-update is disabled', async () => {
      const update = await call('open', '/api/auth/api-key/update', { cookie: user.cookie, body: { keyId: key.id, metadata: { tenantId: operator.me.tenant.id } } });
      expect(update.status).toBe(404);
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

  test('closed sign-up gives byte-identical responses for existing and unknown addresses, with and without mail', async () => {
    if (!scratch) throw new Error('auth database missing');
    for (const mode of ['invite', 'disabled'] as const) {
      for (const mailer of [null, { send: async () => {} }]) {
        const fixture = testAuth(mode, scratch.url, mailer);
        try {
          const app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus });
          const signup = (email: string, invitationId?: string) => app.request('/api/auth/sign-up/email', {
            method: 'POST', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ email, password: 'correct-horse-battery', name: 'Closed signup', invitationId }),
          });
          const registered = await signup(operator.me.user.email);
          const unknown = await signup(`unknown-${crypto.randomUUID()}@example.invalid`);
          expect(registered.status).toBe(403);
          expect(unknown.status).toBe(registered.status);
          expect(await registered.text()).toBe(await unknown.text());
          if (mode === 'invite') {
            const email = `invited-${crypto.randomUUID()}@example.invalid`;
            const invitation = await call('invite', '/api/auth/organization/invite-member', { cookie: operator.cookie, body: { email, role: 'member' } });
            expect(invitation.status).toBe(200);
            const { id } = await invitation.json() as { id: string };
            expect((await signup(email, id)).status).toBe(200);
          }
        } finally {
          await fixture.close();
        }
      }
    }
  });

  test('tenant ownership requires a verified email unless the operator confirms the override', async () => {
    const registered = await signUp('open');
    expect(registered.res.status).toBe(200);
    const body = { name: 'Verified owner required', ownerEmail: registered.email };
    const refused = await call('disabled', '/api/v1/tenants', { cookie: operator.cookie, body });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ detail: 'An unverified account holds that email' });
    expect((await call('disabled', '/api/v1/tenants', { cookie: operator.cookie, body: { ...body, allowUnverifiedOwner: true } })).status).toBe(201);
    await unsafeDb().update(user).set({ emailVerified: true }).where(eq(user.email, registered.email));
    expect((await call('disabled', '/api/v1/tenants', { cookie: operator.cookie, body })).status).toBe(201);
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

  describe('tenant policy and membership audit', () => {
    type Entry = { action: string; actor: { kind: string; userId: string; via: string }; targetType: string; targetId: string; data: Record<string, unknown> };
    const entries = async (cookie: string) => {
      const res = await call('open', '/api/v1/audit-log?limit=100', { cookie });
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: Entry[] }).items;
    };

    test('admins cannot bypass owner policy; owner role changes validate, audit and preserve the last owner', async () => {
      const owner = await signUp('open');
      const ownerMe = (await me('open', owner)).body;
      const admin = await signUp('open');
      const adminMe = (await me('open', admin)).body;
      const memberId = crypto.randomUUID();
      await unsafeDb().insert(member).values({ id: memberId, organizationId: ownerMe.tenant.id, userId: adminMe.user.id, role: 'admin', createdAt: new Date() });
      expect((await call('open', '/api/auth/organization/set-active', { cookie: admin.cookie, body: { organizationId: ownerMe.tenant.id } })).status).toBe(200);
      for (const [path, body] of [
        ['/api/auth/organization/update', { data: { name: 'Bypass', slug: 'INVALID SLUG' } }],
        ['/api/auth/organization/update-member-role', { memberId, role: 'owner' }],
      ] as const) expect((await call('open', path, { cookie: admin.cookie, body })).status).toBe(404);
      expect((await call('open', '/api/v1/tenant', { cookie: admin.cookie, method: 'PATCH', body: { name: 'Bypass' } })).status).toBe(403);
      const patch = (cookie: string, id: string, role: string, extra = {}) => call('open', `/api/v1/members/${id}`, { cookie, method: 'PATCH', body: { role, ...extra } });
      expect((await patch(admin.cookie, memberId, 'owner')).status).toBe(403);
      expect((await patch(owner.cookie, memberId, 'superadmin')).status).toBe(400);
      expect((await patch(owner.cookie, memberId, 'member', { userId: ownerMe.user.id })).status).toBe(400);
      const [ownMember] = await unsafeDb().select().from(member).where(and(eq(member.userId, ownerMe.user.id), eq(member.organizationId, ownerMe.tenant.id)));
      if (!ownMember) throw new Error('owner membership missing');
      const lastOwner = await patch(owner.cookie, ownMember.id, 'member');
      expect(lastOwner.status).toBe(409);
      expect(await lastOwner.json()).toMatchObject({ type: 'https://supercal.dev/problems/last-owner' });
      expect((await patch(owner.cookie, 'missing', 'member')).status).toBe(404);
      const [foreignMember] = await unsafeDb().select().from(member).where(eq(member.organizationId, adminMe.tenant.id));
      if (!foreignMember) throw new Error('foreign membership missing');
      expect((await patch(owner.cookie, foreignMember.id, 'member')).status).toBe(404);
      const calendar = await call('open', '/api/v1/calendars', { cookie: owner.cookie, body: { name: 'Demotion links' } });
      expect(calendar.status).toBe(201);
      const { id: calendarId } = await calendar.json() as { id: string };
      const linksPath = `/api/v1/calendars/${calendarId}/links`;
      for (const cookie of [owner.cookie, admin.cookie])
        expect((await call('open', linksPath, { cookie, body: { privacy: 'busy-only' } })).status).toBe(201);
      await unsafeDb().execute(sql`create function fail_membership_audit() returns trigger language plpgsql as $$
        begin if NEW.action in ('member.role_update', 'member.invite') then raise exception 'audit unavailable'; end if; return NEW; end $$`);
      await unsafeDb().execute(sql`create trigger fail_membership_audit before insert on audit_log for each row execute function fail_membership_audit()`);
      try {
        expect((await patch(owner.cookie, memberId, 'member')).status).toBe(500);
        const [unchanged] = await unsafeDb().select({ role: member.role }).from(member).where(eq(member.id, memberId));
        expect(unchanged?.role).toBe('admin');
        const links = await (await call('open', linksPath, { cookie: owner.cookie })).json() as { items: unknown[] };
        expect(links.items).toHaveLength(2);
        // Better Auth's mutation is already committed: a failed audit must still return success.
        expect((await call('open', '/api/auth/organization/invite-member', { cookie: owner.cookie, body: { email: `audit-failure-${crypto.randomUUID()}@example.invalid`, role: 'member' } })).status).toBe(200);
      } finally {
        await unsafeDb().execute(sql`drop trigger fail_membership_audit on audit_log`);
        await unsafeDb().execute(sql`drop function fail_membership_audit()`);
      }
      expect((await patch(owner.cookie, memberId, 'member')).status).toBe(200);
      const links = await (await call('open', linksPath, { cookie: owner.cookie })).json() as { items: { createdBy: string }[] };
      expect(links.items).toHaveLength(1);
      expect(links.items[0]?.createdBy).toBe(ownerMe.user.id);
      expect((await entries(owner.cookie)).filter((entry) => entry.action === 'member.role_update')).toEqual([
        expect.objectContaining({ actor: { kind: 'user', userId: ownerMe.user.id, via: 'session' }, targetType: 'member', targetId: memberId, data: { from: 'admin', to: 'member' } }),
      ]);
    });

    test('concurrent owner demotions serialize and retain one owner', async () => {
      const first = await signUp('open');
      const firstMe = (await me('open', first)).body;
      const second = await signUp('open');
      const secondMe = (await me('open', second)).body;
      const secondMemberId = crypto.randomUUID();
      await unsafeDb().insert(member).values({ id: secondMemberId, organizationId: firstMe.tenant.id, userId: secondMe.user.id, role: 'owner', createdAt: new Date() });
      expect((await call('open', '/api/auth/organization/set-active', { cookie: second.cookie, body: { organizationId: firstMe.tenant.id } })).status).toBe(200);
      const [firstMember] = await unsafeDb().select().from(member).where(and(eq(member.userId, firstMe.user.id), eq(member.organizationId, firstMe.tenant.id)));
      if (!firstMember) throw new Error('owner membership missing');
      const responses = await Promise.all([
        call('open', `/api/v1/members/${firstMember.id}`, { cookie: first.cookie, method: 'PATCH', body: { role: 'member' } }),
        call('open', `/api/v1/members/${secondMemberId}`, { cookie: second.cookie, method: 'PATCH', body: { role: 'member' } }),
      ]);
      expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
      const members = await unsafeDb().select({ role: member.role }).from(member).where(eq(member.organizationId, firstMe.tenant.id));
      expect(members.filter((row) => row.role === 'owner')).toHaveLength(1);
    });

    test('every remaining organization mutation records exactly one entry with its acting user', async () => {
      const owner = await signUp('open');
      const ownerMe = (await me('open', owner)).body;
      const created = await call('open', '/api/auth/organization/create', { cookie: owner.cookie, body: { name: 'Audited tenant', slug: `audit-${crypto.randomUUID()}` } });
      expect(created.status).toBe(200);
      const tenant = await created.json() as { id: string; name: string; slug: string };
      const expectEntry = async (action: string, actorId: string, type: string, id: string, data: Record<string, unknown>) => {
        expect((await entries(owner.cookie)).filter((entry) => entry.action === action && entry.targetId === id)).toEqual([
          expect.objectContaining({ actor: { kind: 'user', userId: actorId, via: 'session' }, targetType: type, targetId: id, data: expect.objectContaining(data) }),
        ]);
      };
      await expectEntry('tenant.create', ownerMe.user.id, 'tenant', tenant.id, { name: tenant.name, slug: tenant.slug });
      const invite = async (email: string, role = 'member') => {
        const res = await call('open', '/api/auth/organization/invite-member', { cookie: owner.cookie, body: { email, role } });
        expect(res.status).toBe(200);
        const invitation = await res.json() as { id: string };
        await expectEntry('member.invite', ownerMe.user.id, 'invitation', invitation.id, { email, role });
        return invitation.id;
      };
      const canceledEmail = `cancel-${crypto.randomUUID()}@example.invalid`;
      const canceledId = await invite(canceledEmail);
      expect((await call('open', '/api/auth/organization/cancel-invitation', { cookie: owner.cookie, body: { invitationId: canceledId } })).status).toBe(200);
      await expectEntry('member.invite_cancel', ownerMe.user.id, 'invitation', canceledId, { email: canceledEmail, role: 'member' });

      const rejected = await signUp('open');
      const rejectedMe = (await me('open', rejected)).body;
      const rejectedId = await invite(rejected.email);
      expect((await call('open', '/api/auth/organization/reject-invitation', { cookie: rejected.cookie, body: { invitationId: rejectedId } })).status).toBe(200);
      await expectEntry('member.invite_reject', rejectedMe.user.id, 'invitation', rejectedId, { email: rejected.email, role: 'member' });

      const joined = await signUp('open');
      const joinedMe = (await me('open', joined)).body;
      const joinedId = await invite(joined.email, 'admin');
      const accepted = await call('open', '/api/auth/organization/accept-invitation', { cookie: joined.cookie, body: { invitationId: joinedId } });
      expect(accepted.status).toBe(200);
      const { member: membership } = await accepted.json() as { member: { id: string } };
      await expectEntry('member.join', joinedMe.user.id, 'member', membership.id, { email: joined.email, role: 'admin', userId: joinedMe.user.id });
      const before = await entries(owner.cookie);
      expect((await call('open', '/api/auth/organization/invite-member', { cookie: joined.cookie, body: { email: `failed-${crypto.randomUUID()}@example.invalid`, role: 'owner' } })).status).not.toBe(200);
      expect(await entries(owner.cookie)).toEqual(before);
      expect((await call('open', '/api/auth/organization/remove-member', { cookie: owner.cookie, body: { memberIdOrEmail: membership.id } })).status).toBe(200);
      await expectEntry('member.remove', ownerMe.user.id, 'member', membership.id, { role: 'admin', userId: joinedMe.user.id });
      expect((await entries(owner.cookie)).map((entry) => entry.action).sort()).toEqual([
        'tenant.create', 'member.invite', 'member.invite', 'member.invite', 'member.invite_cancel', 'member.invite_reject', 'member.join', 'member.remove',
      ].sort());
    });

    test('operator impersonation, password replacement, tenant deletion and key deletion are disabled', async () => {
      for (const path of ['/admin/impersonate-user', '/admin/set-user-password', '/organization/delete', '/api-key/update', '/api-key/delete']) {
        expect((await call('open', `/api/auth${path}`, { cookie: operator.cookie, body: { userId: operator.me.user.id, newPassword: 'replaced-password', organizationId: operator.me.tenant.id, keyId: 'missing' } })).status).toBe(404);
      }
    });
  });
});

// Separate installs exercise the lock through the HTTP wrapper and the real Better Auth pool.
describe.skipIf(!testDatabaseUrl)('bootstrap sign-up serialization', () => {
  for (const mode of ['open', 'invite', 'disabled'] as const) {
    for (const withMail of [false, true]) {
      test(`${mode}, mail ${withMail}: one operator across concurrent sign-ups`, async () => {
        for (let round = 0; round < 5; round++) {
          const scratch = await scratchDatabase('bootstrap44');
          await migrate(scratch.url);
          connectDb(scratch.url);
          const fixture = testAuth(mode, scratch.url, withMail ? { send: async () => {} } : null);
          try {
            const app = createApi({ auth: fixture.auth, secrets: testSecrets, bus: idleBus });
            const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => app.request('/api/auth/sign-up/email', {
              method: 'POST', headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
              body: JSON.stringify({ email: `first-${index}@example.invalid`, password: 'correct-horse-battery', name: `First ${index}` }),
            })));
            expect(responses.filter((res) => res.status === 200)).toHaveLength(mode === 'open' ? 4 : 1);
            if (mode !== 'open') expect(responses.filter((res) => res.status === 403)).toHaveLength(3);
            const users = await unsafeDb().select({ role: user.role }).from(user);
            expect(users.filter((row) => row.role === 'admin')).toHaveLength(1);
          } finally {
            await fixture.close();
            await closeDb();
            await scratch.drop();
          }
        }
      }, 60_000);
    }
  }
});
