/**
 * `/readyz` and `/metrics` over a scratch database: each readiness check failing and recovering
 * (including a killed bus listener), and the metrics token and database-backed push-lease gauge.
 */
import { calendarAccount, closeDb, connectDb, member, migrate, newId, pushLease, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { startBus, type Bus } from '../src/bus.ts';
import { createApp } from '../src/http.ts';
import { createLogger } from '../src/log.ts';
import { testAuth, testSecrets } from './auth-fixture.ts';

const eventually = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(25);
  }
};

describe.skipIf(!testDatabaseUrl)('ops endpoints', () => {
  let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
  let fixture: ReturnType<typeof testAuth>;
  let bus: Bus;
  let tickedAt: number | null = Date.now();
  let app: ReturnType<typeof createApp>;

  const readyz = async () => {
    const res = await app.request('/readyz');
    return { status: res.status, body: (await res.json()) as { status: string; failing?: string[] } };
  };

  beforeAll(async () => {
    scratch = await scratchDatabase('ops');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('open', scratch.url);
    bus = await startBus(scratch.url, createLogger({}, () => {}), { pingMs: 50 });
    app = createApp(new Set(['worker']), {
      auth: fixture.auth,
      secrets: testSecrets,
      bus,
      icsCacheBytes: 0,
      ops: { schedulerTickedAt: () => tickedAt, metricsToken: 'metrics-secret' },
    });
  });

  afterAll(async () => {
    await bus.close();
    await fixture.close();
    await closeDb();
    await scratch.drop();
  });

  test('is ready when the database, migrations, bus and scheduler are all healthy', async () => {
    expect(await readyz()).toEqual({ status: 200, body: { status: 'ready' } });
  });

  test('a scheduler that has not ticked for 30 s, or never, is not ready', async () => {
    tickedAt = Date.now() - 31_000;
    expect(await readyz()).toMatchObject({ status: 503, body: { failing: ['scheduler'] } });
    tickedAt = null;
    expect(await readyz()).toMatchObject({ status: 503, body: { failing: ['scheduler'] } });
    tickedAt = Date.now();
    expect((await readyz()).status).toBe(200);
  });

  test('a database migrated past (or behind) this binary is not ready', async () => {
    const owner = unsafeDb();
    await owner.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-release', ${Date.now() + 86_400_000})`);
    try {
      expect(await readyz()).toMatchObject({ status: 503, body: { failing: ['migrations'] } });
    } finally {
      await owner.execute(sql`delete from drizzle.__drizzle_migrations where hash = 'from-a-newer-release'`);
    }
    expect((await readyz()).status).toBe(200);
  });

  test('turns 503 when the bus listener connection is killed, and recovers once it listens again', async () => {
    const url = new URL(scratch.url);
    const name = url.pathname.slice(1);
    const admin = postgres(Object.assign(url, { pathname: '/postgres' }).toString(), { max: 1, onnotice: () => {} });
    const allowConnections = (allow: boolean) => admin`alter database ${admin(name)} with allow_connections ${admin.unsafe(String(allow))}`;
    try {
      // Refuse new connections first, so the listener cannot reconnect before readiness notices.
      await allowConnections(false);
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and application_name = 'supercal-bus'`;
      await eventually(async () => (await readyz()).body.failing?.includes('bus') === true);
    } finally {
      await allowConnections(true);
    }
    await eventually(async () => (await readyz()).status === 200);
    await admin.end();
  }, 25_000);

  test('a database that does not answer fails within the 1 s bound', async () => {
    // Accepts connections and never replies, like a hung server.
    const sockets = new Set<Bun.Socket>();
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open: (socket) => void sockets.add(socket), data: () => {} } });
    await closeDb();
    connectDb(`postgres://nobody@127.0.0.1:${silent.port}/silent`);
    try {
      const started = performance.now();
      const { status, body } = await readyz();
      expect({ status, failing: body.failing }).toEqual({ status: 503, failing: ['database'] });
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      for (const socket of sockets) socket.end();
      silent.stop(true);
      await closeDb();
      connectDb(scratch.url);
    }
    expect((await readyz()).status).toBe(200);
  });

  test('/metrics needs the bearer token and reports push leases per provider, derived from the lease target', async () => {
    expect((await app.request('/metrics')).status).toBe(401);
    expect((await app.request('/metrics', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

    await fixture.auth.api.signUpEmail({ body: { email: 'ops@example.invalid', password: 'correct-horse-battery', name: 'Ops' } });
    const [row] = await unsafeDb().select({ userId: member.userId, tenantId: member.organizationId }).from(member);
    if (!row) throw new Error('sign-up created no tenant');
    const owner = { ...row, tenantId: row.tenantId as TenantId };
    const accountId = newId('acc');
    await unsafeDb().insert(calendarAccount).values({ id: accountId, tenantId: owner.tenantId, ownerUserId: owner.userId, provider: 'google', displayName: 'Google' });
    const lease = { tenantId: owner.tenantId, accountId, targetId: 'target', secretHash: 'x' };
    await unsafeDb()
      .insert(pushLease)
      .values([
        { ...lease, target: 'calendar', providerChannelId: 'live-1', expiresAt: new Date(Date.now() + 60_000) },
        { ...lease, target: 'calendar-list', providerChannelId: 'live-2', expiresAt: new Date(Date.now() + 60_000) },
        { ...lease, target: 'calendar', providerChannelId: 'old', expiresAt: new Date(Date.now() - 60_000) },
        { ...lease, target: 'account', providerChannelId: 'graph', expiresAt: new Date(Date.now() + 60_000) },
      ]);

    const res = await app.request('/metrics', { headers: { authorization: 'Bearer metrics-secret' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('supercal_push_leases{provider="google",state="active"} 2\n');
    expect(text).toContain('supercal_push_leases{provider="google",state="expired"} 1\n');
    expect(text).toContain('supercal_push_leases{provider="microsoft",state="active"} 1\n');

    await unsafeDb().delete(pushLease).where(eq(pushLease.accountId, accountId));
  });
});
