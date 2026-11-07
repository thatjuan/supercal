/**
 * `GET /api/v1/stream` over a real Bun server, Better Auth sessions and a scratch database: tenant
 * and visibility filtering, `Last-Event-ID` replay and reset, catch-up after a listener outage,
 * revocation and revalidation, and the per-user limit.
 */
import {
  calendarAccount,
  closeDb,
  feed,
  connectDb,
  member,
  migrate,
  newId,
  recordChanges,
  sourceCalendar,
  systemSetting,
  withTenant,
  type ResourceChange,
  type SourceCalendarId,
  type TenantId,
} from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { createApi } from '../src/api/index.ts';
import type { StreamEvent } from '../src/api/stream.ts';
import { notifyEvent, startBus, type Bus } from '../src/bus.ts';
import { createLogger } from '../src/log.ts';
import { TEST_ORIGIN, testAuth, testSecrets } from './auth-fixture.ts';

/** Resolves once `check` passes, polling every 5 ms; rejects after `ms`. */
async function eventually(check: () => boolean, ms = 5000) {
  for (const deadline = Date.now() + ms; !check(); await Bun.sleep(5)) if (Date.now() > deadline) throw new Error('timed out');
}

type Received = { id: string | undefined; event: StreamEvent; at: number };
type Client = { status: number; events: Received[]; closed: boolean; close(): void };
type Credentials = { cookie?: string; key?: string };

/** Opens a stream as `who` and collects its events until the server ends it or `close` is called. */
async function connect(base: string, who: Credentials, lastEventId?: string, query = ''): Promise<Client> {
  const headers: Record<string, string> = {};
  if (who.cookie) headers.cookie = who.cookie;
  if (who.key) headers.authorization = `Bearer ${who.key}`;
  if (lastEventId) headers['last-event-id'] = lastEventId;
  // Aborting the fetch drops the connection; cancelling the reader alone leaves Bun's socket open.
  const abort = new AbortController();
  const res = await fetch(`${base}/api/v1/stream${query}`, { headers, signal: abort.signal });
  const client: Client = { status: res.status, events: [], closed: !res.ok, close: () => abort.abort() };
  if (!res.ok || !res.body) return client;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffer = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read().catch(() => ({ done: true, value: '' }) as const)) {
      buffer += chunk.value;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const fields = new Map(buffer.slice(0, end).split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
        buffer = buffer.slice(end + 2);
        const data = fields.get('data');
        if (data !== undefined) client.events.push({ id: fields.get('id'), event: JSON.parse(data) as StreamEvent, at: performance.now() });
      }
    }
    client.closed = true;
  })();
  return client;
}

const changed = (client: Client) =>
  client.events.flatMap(({ id, event }) => (event.type === 'resources.changed' ? [{ id, seq: event.seq, calendarIds: [...event.calendarIds].sort() }] : []));

const upsert = (sourceCalendarId: SourceCalendarId, uid: string): ResourceChange => ({
    op: 'upsert',
    sourceCalendarId,
    uid,
    resource: { uid, master: null, overrides: [], timezones: {} },
    revision: crypto.randomUUID(),
    sequence: null,
    lastModified: null,
    organizer: null,
    span: { start: new Date('2026-12-01T10:00:00Z'), end: new Date('2026-12-01T11:00:00Z') },
    completeness: 'complete',
});

/** Commits one change to `calendar`; returns its seq and when the commit finished. */
async function change(tenantId: TenantId, calendar: SourceCalendarId) {
  const { maxSeq } = await withTenant(tenantId, (tx) => recordChanges(tx, [upsert(calendar, crypto.randomUUID())]));
  return { seq: String(maxSeq), committedAt: performance.now() };
}

describe.skipIf(!testDatabaseUrl)('live update stream', () => {
  let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
  let fixture: ReturnType<typeof testAuth>;
  let bus: Bus;
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const clients: Client[] = [];
  /** `base` revalidates every minute (so closures there come from revocation); `quick` every 300 ms. */
  let base: string;
  let quick: string;

  type User = { id: string; email: string; cookie: string };
  let ownerA: User, adminA: User, memberA: User, ownerB: User;
  let tenantA: TenantId, tenantB: TenantId;
  const calendars = { ownerA: newId('cal'), memberA: newId('cal'), ownerB: newId('cal') };
  const accounts = { ownerA: newId('acc'), memberA: newId('acc'), ownerB: newId('acc') };
  const ownerFeed = newId('feed');

  const authCall = (path: string, cookie: string, body: unknown) =>
    fixture.auth.handler(
      new Request(`${TEST_ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );

  let counter = 0;
  /** Signs up a user (who gets a personal tenant) and returns them with their session cookie and tenant. */
  async function signUp() {
    const email = `stream${++counter}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
    const res = await authCall('/sign-up/email', '', { email, password: 'correct-horse-battery', name: `Stream ${counter}` });
    const cookie = res.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    const { user } = (await res.json()) as { user: { id: string } };
    const [row] = await unsafeDb().select({ tenantId: member.organizationId }).from(member).where(eq(member.userId, user.id));
    if (!row) throw new Error('sign-up created no tenant');
    return { id: user.id, email, cookie, tenantId: row.tenantId as TenantId };
  }

  /** Signs up a user and makes them `role` in `tenantId`, acting there. */
  async function joined(tenantId: TenantId, role: 'member' | 'admin'): Promise<User> {
    const user = await signUp();
    await unsafeDb().insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId: user.id, role, createdAt: new Date() });
    expect((await authCall('/organization/set-active', user.cookie, { organizationId: tenantId })).status).toBe(200);
    return user;
  }

  const open = async (url: string, who: Credentials, lastEventId?: string, query?: string) => {
    const client = await connect(url, who, lastEventId, query);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    scratch = await scratchDatabase('stream');
    await migrate(scratch.url);
    connectDb(scratch.url);
    fixture = testAuth('open', scratch.url);
    bus = await startBus(scratch.url, createLogger({}, () => {}), { pingMs: 50 });
    for (const revalidateMs of [60_000, 300]) {
      const app = createApi({ auth: fixture.auth, secrets: testSecrets, bus, stream: { revalidateMs } });
      servers.push(Bun.serve({ port: 0, fetch: app.fetch }));
    }
    [base, quick] = servers.map((server) => server.url.origin) as [string, string];

    const a = await signUp();
    const b = await signUp();
    [ownerA, ownerB, tenantA, tenantB] = [a, b, a.tenantId, b.tenantId];
    adminA = await joined(tenantA, 'admin');
    memberA = await joined(tenantA, 'member');

    const owned = [
      ['ownerA', tenantA, ownerA],
      ['memberA', tenantA, memberA],
      ['ownerB', tenantB, ownerB],
    ] as const;
    await unsafeDb()
      .insert(calendarAccount)
      .values(owned.map(([name, tenantId, user]) => ({ id: accounts[name], tenantId, ownerUserId: user.id, provider: 'ics' as const, displayName: name })));
    await unsafeDb()
      .insert(sourceCalendar)
      .values(owned.map(([name, tenantId]) => ({ id: calendars[name], tenantId, accountId: accounts[name], providerCalendarId: name, name })));
    await unsafeDb()
      .insert(feed)
      .values({ id: ownerFeed, tenantId: tenantA, ownerUserId: ownerA.id, name: 'Feed', caldavUsername: `feed-${ownerFeed}`, uidSecret: 'unused' });
  });

  afterAll(async () => {
    // Clients hang up first: Bun's stop(true) can wait on a stream the server ended itself.
    clients.forEach((client) => client.close());
    await Bun.sleep(100);
    await Promise.all(servers.map((server) => server.stop(true)));
    await bus.close();
    await fixture.close();
    await closeDb();
    await scratch.drop();
  });

  test('a change reaches its tenant’s subscribers within 100 ms of commit, and never another tenant’s', async () => {
    const subscribers = await Promise.all([ownerA, adminA, ownerB].map((user) => open(base, user)));
    const [owner, admin, other] = subscribers as [Client, Client, Client];
    expect(subscribers.map((client) => client.status)).toEqual([200, 200, 200]);
    await Bun.sleep(300); // past the coalescing window of each stream's initial catch-up

    const { seq, committedAt } = await change(tenantA, calendars.ownerA);
    await eventually(() => changed(owner).length > 0 && changed(admin).length > 0);
    for (const client of [owner, admin]) {
      expect(changed(client)).toEqual([{ id: seq, seq, calendarIds: [calendars.ownerA] }]);
      expect((client.events.at(-1)?.at ?? Infinity) - committedAt).toBeLessThan(100);
    }
    await Bun.sleep(300);
    expect(other.events).toEqual([]);
  });

  test('a member sees only their own accounts and feeds; an admin sees the whole tenant', async () => {
    const [memberStream, adminStream] = await Promise.all([open(base, memberA), open(base, adminA)]);
    await Bun.sleep(300);

    await change(tenantA, calendars.ownerA);
    const own = await change(tenantA, calendars.memberA);
    await withTenant(tenantA, async (tx) => {
      await notifyEvent(tx, tenantA, { type: 'account.status', accountId: accounts.ownerA, status: 'error', detail: 'boom' });
      await notifyEvent(tx, tenantA, { type: 'account.status', accountId: accounts.memberA, status: 'reauth_required' });
      await notifyEvent(tx, tenantA, { type: 'feed.changed', feedId: ownerFeed });
    });

    await eventually(() => adminStream.events.length >= 4 && memberStream.events.length >= 2);
    await Bun.sleep(300);
    expect(changed(memberStream)).toEqual([{ id: own.seq, seq: own.seq, calendarIds: [calendars.memberA] }]);
    expect(changed(adminStream).flatMap((e) => e.calendarIds).sort()).toEqual([calendars.ownerA, calendars.memberA].sort());
    expect(memberStream.events.map((e) => e.event).filter((e) => e.type === 'account.status')).toEqual([
      { type: 'account.status', accountId: accounts.memberA, status: 'reauth_required' },
    ]);
    expect(adminStream.events.map((e) => e.event).filter((e) => e.type === 'account.status')).toEqual([
      { type: 'account.status', accountId: accounts.ownerA, status: 'error', detail: 'boom' },
      { type: 'account.status', accountId: accounts.memberA, status: 'reauth_required' },
    ]);
    expect(adminStream.events.map((e) => e.event)).toContainEqual({ type: 'feed.changed', feedId: ownerFeed });
    expect(memberStream.events.map((e) => e.event.type)).not.toContain('feed.changed');
  });

  test('Last-Event-ID replays exactly the changes after it', async () => {
    const first = await change(tenantA, calendars.ownerA);
    const second = await change(tenantA, calendars.ownerA);
    const third = await change(tenantA, calendars.memberA);

    const fromFirst = await open(base, adminA, first.seq);
    const fromSecond = await open(base, adminA, undefined, `?lastEventId=${second.seq}`);
    await eventually(() => changed(fromFirst).length > 0 && changed(fromSecond).length > 0);
    await Bun.sleep(300);
    expect(changed(fromFirst)).toEqual([{ id: third.seq, seq: third.seq, calendarIds: [calendars.ownerA, calendars.memberA].sort() }]);
    expect(changed(fromSecond)).toEqual([{ id: third.seq, seq: third.seq, calendarIds: [calendars.memberA] }]);
    expect((await open(base, adminA, 'not-a-seq')).status).toBe(400);
  });

  test('a Last-Event-ID below the tombstone floor gets reset, then only new changes', async () => {
    const old = await change(tenantA, calendars.ownerA);
    const floor = await change(tenantA, calendars.ownerA);
    const setFloor = (value: string) => unsafeDb().update(systemSetting).set({ value }).where(eq(systemSetting.key, 'tombstone_floor'));
    await setFloor(floor.seq);
    try {
      const client = await open(base, adminA, String(BigInt(old.seq) - 1n));
      await eventually(() => client.events.length > 0);
      await Bun.sleep(300);
      expect(client.events.map((e) => e.event)).toEqual([{ type: 'reset' }]);

      const next = await change(tenantA, calendars.ownerA);
      await eventually(() => changed(client).length > 0);
      expect(changed(client)).toEqual([{ id: next.seq, seq: next.seq, calendarIds: [calendars.ownerA] }]);
    } finally {
      await setFloor('0');
    }
  });

  test('a change committed while the listener is down arrives after it reconnects', async () => {
    const client = await open(base, ownerA);
    await Bun.sleep(300);
    const url = new URL(scratch.url);
    const name = url.pathname.slice(1);
    const admin = postgres(Object.assign(url, { pathname: '/postgres' }).toString(), { max: 1, onnotice: () => {} });
    const allowConnections = (allow: boolean) => admin`alter database ${admin(name)} with allow_connections ${admin.unsafe(String(allow))}`;
    try {
      await allowConnections(false);
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and application_name = 'supercal-bus'`;
      await eventually(() => !bus.connected);
      const lost = await change(tenantA, calendars.ownerA); // its NOTIFY reaches nobody
      await Bun.sleep(300);
      expect(changed(client)).toEqual([]);

      await allowConnections(true);
      await eventually(() => changed(client).length > 0, 10_000);
      expect(changed(client)).toEqual([{ id: lost.seq, seq: lost.seq, calendarIds: [calendars.ownerA] }]);
    } finally {
      await allowConnections(true).finally(() => admin.end());
    }
  }, 20_000);

  test('losing membership closes the stream within the revalidation window, and reconnecting is refused', async () => {
    const user = await joined(tenantA, 'member');
    const client = await open(quick, user);
    expect(client.status).toBe(200);
    await unsafeDb()
      .delete(member)
      .where(and(eq(member.userId, user.id), eq(member.organizationId, tenantA)));
    const removedAt = performance.now();
    await eventually(() => client.closed, 2000);
    expect(performance.now() - removedAt).toBeLessThan(700);
    expect((await open(quick, user)).status).toBe(403);
  });

  test('a role change that alters visibility closes the stream at revalidation', async () => {
    const user = await joined(tenantA, 'member');
    const client = await open(quick, user);
    await unsafeDb()
      .update(member)
      .set({ role: 'admin' })
      .where(and(eq(member.userId, user.id), eq(member.organizationId, tenantA)));
    await eventually(() => client.closed, 2000);
    expect((await open(quick, user)).status).toBe(200);
  });

  test('sign-out, removal through Better Auth and API-key deletion close streams at once', async () => {
    const signedOut = await joined(tenantA, 'member');
    const removed = await joined(tenantA, 'member');
    const keyHolder = await joined(tenantA, 'member');
    const keyRes = await fetch(`${base}/api/v1/api-keys`, {
      method: 'POST',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json', cookie: keyHolder.cookie },
      body: JSON.stringify({ name: 'stream' }),
    });
    const key = (await keyRes.json()) as { id: string; key: string };

    const streams = await Promise.all([open(base, signedOut), open(base, removed), open(base, { key: key.key })]);
    expect(streams.map((client) => client.status)).toEqual([200, 200, 200]);
    const [a, b, c] = streams as [Client, Client, Client];

    expect((await authCall('/sign-out', signedOut.cookie, {})).status).toBe(200);
    await eventually(() => a.closed, 1000);
    expect((await authCall('/organization/remove-member', ownerA.cookie, { memberIdOrEmail: removed.email, organizationId: tenantA })).status).toBe(200);
    await eventually(() => b.closed, 1000);
    const deleted = await fetch(`${base}/api/v1/api-keys/${key.id}`, { method: 'DELETE', headers: { origin: TEST_ORIGIN, cookie: keyHolder.cookie } });
    expect(deleted.status).toBe(204);
    await eventually(() => c.closed, 1000);

    expect((await open(base, signedOut)).status).toBe(401);
    expect((await open(base, { key: key.key })).status).toBe(401);
  });

  test('a user may hold 20 streams; the 21st gets 429', async () => {
    const user = await joined(tenantA, 'member');
    const streams = await Promise.all(Array.from({ length: 20 }, () => open(base, user)));
    expect(streams.every((client) => client.status === 200)).toBe(true);
    expect((await open(base, user)).status).toBe(429);
    streams[0]?.close();
    await Bun.sleep(50); // the server sees the cancel
    expect((await open(base, user)).status).toBe(200);
  });
});
