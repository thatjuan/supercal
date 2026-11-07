import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { source } from '../scripts/embed-migrations.ts';
import { migrate } from './migrate.ts';
import { scratchDatabase, testDatabaseUrl } from './test-db.ts';

test('the embedded migration manifest matches the migrations folder', async () => {
  expect(await Bun.file(new URL('./migrations.generated.ts', import.meta.url)).text()).toBe(source);
});

describe.skipIf(!testDatabaseUrl)('migrate', () => {
  test('two concurrent runs on a fresh database succeed and only one applies', async () => {
    const { url, drop } = await scratchDatabase('migrate');
    const runs = await Promise.all([migrate(url), migrate(url)]);
    expect(runs.map((run) => run.applied).sort()).toEqual([0, 3]);

    const sql = postgres(url, { max: 1 });
    try {
      const [state] = await sql`
        select
          (select count(*)::int from pg_tables where schemaname = 'public') as tables,
          (select count(*)::int from pg_class where relkind = 'r' and relforcerowsecurity) as forced_rls,
          (select value from system_setting where key = 'tombstone_floor') as tombstone_floor,
          to_regclass('change_seq') is not null as change_seq`;
      expect(state).toEqual({ tables: 23, forced_rls: 14, tombstone_floor: 0, change_seq: true });
      expect(await migrate(url)).toEqual({ applied: 0 });
    } finally {
      await sql.end();
      await drop();
    }
  });
});
