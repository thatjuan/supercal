/** Real sessions and membership routes for departure tests; only the initial organization is seeded. */
import { member, organization, user, type TenantId } from '@supercal/db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createApi } from '../src/api/index.ts';
import { idleBus } from '../src/bus.ts';
import type { Auth } from '../src/auth/auth.ts';
import { TEST_ORIGIN, testSecrets } from './auth-fixture.ts';

export async function departureActors(auth: Auth) {
  const tenantId = crypto.randomUUID() as TenantId;
  const password = 'correct-horse-battery';
  const createUser = async (name: string) => {
    const email = `${crypto.randomUUID()}@departure.test`;
    const created = await auth.api.signUpEmail({ body: { name, email, password } });
    return { id: created.user.id, email };
  };
  const owner = await createUser('Departure admin'), departing = await createUser('Departing member');
  await unsafeDb().update(user).set({ role: 'admin' }).where(eq(user.id, owner.id));
  await unsafeDb().insert(organization).values({ id: tenantId, name: 'Departure', slug: tenantId, createdAt: new Date() });
  await unsafeDb().insert(member).values([owner, departing].map((person) => ({
    id: crypto.randomUUID(), organizationId: tenantId, userId: person.id,
    role: person === owner ? 'owner' : 'member', createdAt: new Date(),
  })));
  const authCall = (path: string, cookie: string, body: unknown) => auth.handler(new Request(`${TEST_ORIGIN}/api/auth${path}`, {
    method: 'POST', headers: { origin: TEST_ORIGIN, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const signIn = async (email: string) => {
    const response = await authCall('/sign-in/email', '', { email, password });
    expect(response.status).toBe(200);
    return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  };
  const ownerCookie = await signIn(owner.email), cookie = await signIn(departing.email);
  // Existing personal memberships may precede this fixture's organization.
  expect((await authCall('/organization/set-active', cookie, { organizationId: tenantId })).status).toBe(200);
  expect((await authCall('/organization/set-active', ownerCookie, { organizationId: tenantId })).status).toBe(200);
  const api = createApi({ auth, secrets: testSecrets, bus: idleBus });
  const apiCall = (path: string, method = 'GET', body?: unknown, as = cookie) => api.request(`/api/v1${path}`, {
    method, headers: { cookie: as, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return {
    api, apiCall, tenantId, owner, departing, cookie, ownerCookie, authCall,
    async remove() {
      expect((await authCall('/organization/remove-member', ownerCookie, { organizationId: tenantId, memberIdOrEmail: departing.email })).status).toBe(200);
    },
    async rejoin() {
      const response = await authCall('/organization/invite-member', ownerCookie, { organizationId: tenantId, email: departing.email, role: 'member' });
      expect(response.status).toBe(200);
      const invitation = z.object({ id: z.string() }).parse(await response.json());
      expect((await authCall('/organization/accept-invitation', cookie, { invitationId: invitation.id })).status).toBe(200);
    },
    async ban(banned: boolean) {
      expect((await authCall(banned ? '/admin/ban-user' : '/admin/unban-user', ownerCookie, { userId: departing.id })).status).toBe(200);
    },
  };
}

export const FeedCredentials = z.object({
  feed: z.object({ id: z.string() }),
  credentials: z.object({
    caldav: z.object({ username: z.string(), password: z.string() }),
    ics: z.object({ token: z.string() }),
  }),
});
export const basicCredentials = (login: { username: string; password: string }) => `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`;
