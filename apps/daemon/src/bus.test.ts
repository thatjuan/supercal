import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeDb, connectDb, migrate, newId, withControl, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import postgres from 'postgres';
import { FEED_CREDENTIALS_CHANNEL, startBus, wake, WAKE_CHANNEL, type Bus, type BusEvents } from './bus.ts';
import { createLogger } from './log.ts';

/** Resolves once `check` passes, polling every 10 ms; rejects after `ms`. */
async function eventually(check: () => boolean, ms = 5000) {
  for (const deadline = Date.now() + ms; !check(); await Bun.sleep(10)) if (Date.now() > deadline) throw new Error('timed out');
}

describe.skipIf(!testDatabaseUrl)('notification bus', () => {
  let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
  let notifier: postgres.Sql;
  let bus: Bus;
  const logs: { level: string; msg: string }[] = [];
  const events: { [E in keyof BusEvents]: BusEvents[E][] } = { change: [], wake: [], 'feed-credentials-rotated': [], reconnected: [] };

  beforeAll(async () => {
    scratch = await scratchDatabase('bus');
    await migrate(scratch.url);
    connectDb(scratch.url);
    notifier = postgres(scratch.url, { max: 1, onnotice: () => {} });
    bus = await startBus(scratch.url, createLogger({}, (line) => logs.push(JSON.parse(line))), { pingMs: 50 });
    bus.on('change', (e) => events.change.push(e));
    bus.on('wake', (e) => events.wake.push(e));
    bus.on('feed-credentials-rotated', (e) => events['feed-credentials-rotated'].push(e));
    bus.on('reconnected', (e) => events.reconnected.push(e));
  });

  afterAll(async () => {
    await bus.close();
    await notifier.end();
    await closeDb();
    await scratch.drop();
  });

  test('emits typed events and drops malformed payloads', async () => {
    const target = newId('tgt');
    const feed = newId('feed');
    for (const [channel, payload] of [
      ['supercal_changes', '{"t":"org_1","s":"42"}'],
      ['supercal_changes', 'not json'],
      ['supercal_changes', '{"t":"org_1","s":"4.2"}'],
      [WAKE_CHANNEL, '{"ids":["acc_1"]}'],
      [WAKE_CHANNEL, JSON.stringify({ ids: [target] })],
      [FEED_CREDENTIALS_CHANNEL, JSON.stringify({ f: target })],
      [FEED_CREDENTIALS_CHANNEL, JSON.stringify({ f: feed })],
    ] as const)
      await notifier`select pg_notify(${channel}, ${payload})`;

    await eventually(() => events.wake.length > 0 && events['feed-credentials-rotated'].length > 0);
    expect(events.change).toEqual([{ tenantId: 'org_1' as TenantId, maxSeq: 42n }]);
    expect(events.wake).toEqual([{ targetIds: [target] }]);
    expect(events['feed-credentials-rotated']).toEqual([{ feedId: feed }]);
    expect(logs.filter((line) => line.msg === 'dropped malformed notification')).toHaveLength(4);
    expect(bus.connected).toBe(true);
  });

  test('wake chunks large id lists into payloads under 7000 bytes, sent on commit', async () => {
    events.wake.length = 0;
    const sizes: number[] = [];
    const raw = await notifier.listen(WAKE_CHANNEL, (payload) => sizes.push(Buffer.byteLength(payload)));
    const ids = Array.from({ length: 1000 }, () => newId('tgt'));
    await withControl(async (tx) => {
      await wake(tx, ids);
      await Bun.sleep(100);
      expect(events.wake).toEqual([]);
    });

    await eventually(() => events.wake.flatMap((e) => e.targetIds).length === ids.length);
    expect(events.wake.flatMap((e) => e.targetIds)).toEqual(ids);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(7000);
    await raw.unlisten();
  });

  test('reports a lost connection and emits reconnected once it listens again', async () => {
    const url = new URL(scratch.url);
    const name = url.pathname.slice(1);
    const admin = postgres(Object.assign(url, { pathname: '/postgres' }).toString(), { max: 1, onnotice: () => {} });
    const allowConnections = (allow: boolean) => admin`alter database ${admin(name)} with allow_connections ${admin.unsafe(String(allow))}`;
    await allowConnections(false);
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and application_name = 'supercal-bus'`;
    await eventually(() => !bus.connected);
    expect(events.reconnected).toEqual([]);

    await allowConnections(true).finally(() => admin.end());
    await eventually(() => events.reconnected.length === 1 && bus.connected, 10_000);
    await notifier`select pg_notify('supercal_changes', '{"t":"org_2","s":"7"}')`;
    await eventually(() => events.change.some((e) => e.maxSeq === 7n));
  }, 20_000);
});
