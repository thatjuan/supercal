import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { source } from '../scripts/embed-migrations.ts';
import { migrate } from './migrate.ts';
import { migrations } from './migrations.generated.ts';
import { scratchDatabase, testDatabaseUrl } from './test-db.ts';

test('the embedded migration manifest matches the migrations folder', async () => {
  expect(await Bun.file(new URL('./migrations.generated.ts', import.meta.url)).text()).toBe(source);
});

describe.skipIf(!testDatabaseUrl)('migrate', () => {
  test('supercal_app can update only roles in its own tenant', async () => {
    const { url, drop } = await scratchDatabase('member_roles');
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await migrate(url);
      await sql`insert into "user" (id, name, email, updated_at) values ('role-user', 'Role user', 'roles@example.invalid', now())`;
      await sql`insert into organization (id, name, slug, created_at) values ('role-a', 'A', 'role-a', now()), ('role-b', 'B', 'role-b', now())`;
      await sql`insert into member (id, organization_id, user_id, role, created_at) values ('member-a', 'role-a', 'role-user', 'owner', now()), ('member-b', 'role-b', 'role-user', 'owner', now())`;
      await sql.begin(async (tx) => {
        await tx`set local role supercal_app`;
        await tx`select set_config('app.tenant_id', 'role-a', true)`;
        expect([...(await tx`select id, role from member for update`)]).toEqual([{ id: 'member-a', role: 'owner' }]);
        expect([...(await tx`update member set role = 'admin' where id = 'member-a' returning id, role`)]).toEqual([{ id: 'member-a', role: 'admin' }]);
        expect([...(await tx`update member set role = 'member' where id = 'member-b' returning id`)]).toEqual([]);
      });
      expect([...(await sql`select role from member where id = 'member-b'`)]).toEqual([{ role: 'owner' }]);
      for (const statement of ["update member set user_id = 'role-user'", "update member set organization_id = 'role-b'", "update member set id = 'changed'", 'update member set created_at = now()']) {
        await expect(sql.begin(async (tx) => {
          await tx`set local role supercal_app`;
          await tx`select set_config('app.tenant_id', 'role-a', true)`;
          await tx.unsafe(statement);
        })).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await sql.end();
      await drop();
    }
  });

  test('two concurrent runs on a fresh database succeed and only one applies', async () => {
    const { url, drop } = await scratchDatabase('migrate');
    const runs = await Promise.all([migrate(url), migrate(url)]);
    expect(runs.map((run) => run.applied).sort()).toEqual([0, migrations.journal.entries.length]);

    const sql = postgres(url, { max: 1 });
    try {
      const [state] = await sql`
        select
          (select count(*)::int from pg_tables where schemaname = 'public') as tables,
          (select count(*)::int from pg_class where relkind = 'r' and relforcerowsecurity) as forced_rls,
          (select value from system_setting where key = 'tombstone_floor') as tombstone_floor,
          to_regclass('change_seq') is not null as change_seq`;
      expect(state).toEqual({ tables: 27, forced_rls: 18, tombstone_floor: 0, change_seq: true });
      expect(await migrate(url)).toEqual({ applied: 0 });
    } finally {
      await sql.end();
      await drop();
    }
  });
});
