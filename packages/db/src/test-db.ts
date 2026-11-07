/** Test-only: the Postgres from `TEST_DATABASE_URL`, and scratch databases beside it. */
import postgres from 'postgres';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) console.warn('TEST_DATABASE_URL is unset: skipping database tests. Point it at a throwaway Postgres 18 database.');

/** Creates an empty `<test database>_<suffix>` (replacing a leftover one); `drop` removes it. */
export async function scratchDatabase(suffix: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const url = new URL(testDatabaseUrl ?? '');
  const name = `${url.pathname.slice(1)}_${suffix}`;
  url.pathname = '/postgres';
  const admin = async (statement: string) => {
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await sql.unsafe(statement).finally(() => sql.end());
  };
  await admin(`drop database if exists "${name}" with (force)`);
  await admin(`create database "${name}"`);
  return {
    url: Object.assign(new URL(url), { pathname: `/${name}` }).toString(),
    drop: () => admin(`drop database if exists "${name}" with (force)`),
  };
}

/** The SQLSTATE a rejected query failed with (Drizzle wraps the driver error in `cause`). */
export async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const code: unknown = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
