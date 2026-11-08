/**
 * The scheduler across processes: three worker processes (`sync-load-worker.ts`) run 500 fake
 * calendars for 30 s while targets are woken at random and one process is frozen past its leases.
 * Triggers record every claim and every committed end transaction; no two runs of a calendar may
 * both commit while their leases overlap, and every calendar must sync.
 */
import { calendarAccount, closeDb, connectDb, createSecretBox, member, migrate, newId, organization, resource, sourceCalendar, syncTarget, user, withControl, type TenantId } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { unsafeDb } from '@supercal/db/unsafe-db';
import { ProviderCredentials } from '@supercal/providers';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { join } from 'node:path';
import { wakeTargets } from '../src/sync/scheduler.ts';

const CALENDARS = 500;
const ACCOUNTS = 50;
const DURATION_MS = 30_000;
const tenantId = `org_${crypto.randomUUID()}` as TenantId;
const userId = `user_${crypto.randomUUID()}`;
let scratch: Awaited<ReturnType<typeof scratchDatabase>> | undefined;

/** Records claims (a new lease version) and committed end transactions (the cursor write) of `sync_target`. */
const AUDIT = sql`
  create table sync_audit (target_id text not null, version bigint not null, event text not null, at timestamptz not null default clock_timestamp());
  create function sync_audit() returns trigger language plpgsql security definer as $$
  begin
    if new.lease_version <> old.lease_version then
      insert into sync_audit (target_id, version, event) values (new.id, new.lease_version, 'claim');
    end if;
    if tg_argv[0] = 'commit' then
      insert into sync_audit (target_id, version, event) values (new.id, new.lease_version, 'commit');
    end if;
    return new;
  end $$;
  create trigger sync_audit_claim after update on sync_target for each row execute function sync_audit('claim');
  create trigger sync_audit_commit after update of cursor on sync_target for each row execute function sync_audit('commit');`;

describe.skipIf(!testDatabaseUrl)('scheduler under load', () => {
  beforeAll(async () => {
    scratch = await scratchDatabase('sync_load');
    await migrate(scratch.url);
    connectDb(scratch.url);
    const db = unsafeDb();
    const secrets = await createSecretBox({ insecureDev: true, warn: () => {} });
    const now = new Date();
    await db.insert(organization).values({ id: tenantId, name: 'Load', slug: tenantId, createdAt: now });
    await db.insert(user).values({ id: userId, name: 'Load', email: 'load@example.com', updatedAt: now });
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: tenantId, userId, role: 'member', createdAt: now });
    for (let a = 0; a < ACCOUNTS; a++) {
      const id = newId('acc');
      const credentials = await secrets.encryptJson(ProviderCredentials, { provider: 'ics', url: `https://load.example.test/${a}.ics` }, { tenantId, table: 'calendar_account', recordId: id, field: 'credentials' });
      await db.insert(calendarAccount).values({ id, tenantId, ownerUserId: userId, provider: 'ics', displayName: `Load ${a}`, credentials });
      const perAccount = CALENDARS / ACCOUNTS;
      const calendars = await db
        .insert(sourceCalendar)
        .values(Array.from({ length: perAccount }, (_, i) => ({ tenantId, accountId: id, providerCalendarId: `c${a * perAccount + i}`, name: `c${a * perAccount + i}` })))
        .returning({ id: sourceCalendar.id });
      await db.insert(syncTarget).values(calendars.map((c) => ({ tenantId, kind: 'events' as const, targetId: c.id })));
    }
    await db.execute(AUDIT);
  });

  afterAll(async () => {
    await closeDb();
    await scratch?.drop();
  });

  test(
    'three processes sync every calendar, and no two overlapping leases both commit',
    async () => {
      const db = unsafeDb();
      const env = { ...process.env, DATABASE_URL: scratch?.url ?? '', CALENDARS: String(CALENDARS), DURATION_MS: String(DURATION_MS) };
      const workers = [0, 1, 2].map(() => Bun.spawn([process.execPath, join(import.meta.dir, 'sync-load-worker.ts')], { env, stdout: 'pipe', stderr: 'pipe' }));
      const targets = (await db.select({ id: syncTarget.id }).from(syncTarget)).map((t) => t.id);

      // Webhook-style wake-ups throughout, and one process frozen for 2.5 s (2.5 leases).
      const started = Date.now();
      const frozen = workers[0]?.pid ?? 0;
      setTimeout(() => process.kill(frozen, 'SIGSTOP'), 8_000);
      setTimeout(() => process.kill(frozen, 'SIGCONT'), 10_500);
      while (Date.now() - started < DURATION_MS - 4_000) {
        const picked = Array.from({ length: 40 }, () => targets[Math.floor(Math.random() * targets.length)]).filter((id) => id !== undefined);
        await withControl((tx) => wakeTargets(tx, [...new Set(picked)]));
        await Bun.sleep(250);
      }

      const results = await Promise.all(workers.map(async (w) => ({ exit: await w.exited, stdout: await new Response(w.stdout).text(), stderr: await new Response(w.stderr).text() })));
      for (const r of results) expect(r).toMatchObject({ exit: 0 });
      const runs = results.map((r) => (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { runs: number }).runs);

      const [overlaps] = await db.execute<{ count: number }>(sql`
        with runs as (
          select c.target_id, c.version, c.at as claimed, m.at as committed
          from sync_audit c join sync_audit m on m.target_id = c.target_id and m.version = c.version and m.event = 'commit'
          where c.event = 'claim')
        select count(*)::int as count from runs a join runs b on a.target_id = b.target_id and a.version < b.version
        where a.claimed < b.committed and b.claimed < a.committed`);
      const [takeovers] = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from sync_audit c
        where c.event = 'claim'
          and not exists (select 1 from sync_audit m where m.target_id = c.target_id and m.version = c.version and m.event = 'commit')
          and exists (select 1 from sync_audit n where n.target_id = c.target_id and n.version > c.version and n.event = 'commit')`);
      const synced = await db.select({ id: syncTarget.id }).from(syncTarget).where(isNotNull(syncTarget.lastSuccessAt));
      const live = await db.select({ uid: resource.uid }).from(resource).where(eq(resource.deleted, false));

      console.log(JSON.stringify({ runs, takeovers: takeovers?.count, overlaps: overlaps?.count }));
      // The frozen process lost leases mid-run, and its late writes were fenced off.
      expect(takeovers?.count).toBeGreaterThan(0);
      expect(overlaps?.count).toBe(0);
      expect(synced).toHaveLength(CALENDARS);
      expect(live).toHaveLength(CALENDARS);
      expect(runs.every((n) => n > 0)).toBe(true);
    },
    DURATION_MS + 30_000,
  );
});
