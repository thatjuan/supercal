/** Master-key rotation for feed UID secrets: reading one under an older key re-encrypts it in place. */
import { closeDb, connectDb, createSecretBox, feed, member, migrate, newId, withTenant, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { newUidSecret, openUidSecret } from '../src/feeds/credentials.ts';
import { testAuth } from './auth-fixture.ts';

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let fixture: ReturnType<typeof testAuth>;

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  scratch = await scratchDatabase('rotation');
  await migrate(scratch.url);
  connectDb(scratch.url);
  fixture = testAuth('open', scratch.url);
});

afterAll(async () => {
  if (!testDatabaseUrl) return;
  await fixture.close();
  await closeDb();
  await scratch.drop();
});

test.skipIf(!testDatabaseUrl)('a feed UID secret sealed under a retired key is re-sealed under the active key, keeping its value', async () => {
  const [v1, v2] = [key(), key()];
  const before = await createSecretBox({ keys: `v1:${v1}` });
  const after = await createSecretBox({ keys: `v2:${v2},v1:${v1}` });

  await fixture.auth.api.signUpEmail({ body: { email: 'rotate@example.invalid', password: 'correct-horse-battery', name: 'Rotate' } });
  const [owner] = await unsafeDb().select({ userId: member.userId, tenantId: member.organizationId }).from(member);
  if (!owner) throw new Error('sign-up created no tenant');
  const tenantId = owner.tenantId as TenantId;
  const id = newId('feed');
  const sealed = await newUidSecret(before, { tenantId, id });
  await unsafeDb().insert(feed).values({ id, tenantId, ownerUserId: owner.userId, name: 'Feed', caldavUsername: `feed-${id}`, uidSecret: sealed });

  const sign = async (hmac: CryptoKey) => Buffer.from(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode('uid'))).toString('hex');
  const original = await withTenant(tenantId, (tx) => openUidSecret(before, { tenantId, id, uidSecret: sealed }, tx).then(sign));
  const reopened = await withTenant(tenantId, (tx) => openUidSecret(after, { tenantId, id, uidSecret: sealed }, tx).then(sign));
  expect(reopened).toBe(original);

  const [row] = await unsafeDb().select({ uidSecret: feed.uidSecret }).from(feed).where(eq(feed.id, id));
  expect(row?.uidSecret.startsWith('sc1.v2.')).toBe(true);
  const v2Only = await createSecretBox({ keys: `v2:${v2}` });
  expect(await withTenant(tenantId, (tx) => openUidSecret(v2Only, { tenantId, id, uidSecret: row?.uidSecret ?? '' }, tx).then(sign))).toBe(original);
});
