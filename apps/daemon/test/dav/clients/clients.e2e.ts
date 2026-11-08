/**
 * Real CalDAV clients against the daemon (`bun run test:dav-clients`; needs `uv` on PATH, so it is
 * not part of plain `bun test`). Each client gets its own scratch database, seeded by
 * `fixture.ts`, and its own daemon process (`src/main.ts`, `dav` role, a random port). The client
 * scripts assert on their own and exit non-zero on failure.
 */
import { closeDb, connectDb, migrate } from '@supercal/db';
import { scratchDatabase, testDatabaseUrl } from '@supercal/db/test-db';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALICE, seed } from '../fixture.ts';

const here = import.meta.dir;
const MAIN = join(here, '../../../src/main.ts');

/** Seeds a scratch database, starts a daemon on it, runs `cmd` against it, and tears both down. */
async function runClient(name: string, cmd: string[]) {
  const scratch = await scratchDatabase(`clients_${name}`);
  const workdir = await mkdtemp(join(tmpdir(), `supercal-${name}-`));
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await migrate(scratch.url);
    connectDb(scratch.url);
    await seed();
    await closeDb();

    const env = { ...process.env, DATABASE_URL: scratch.url, PORT: '0', SUPERCAL_INSECURE_DEV: '1', SUPERCAL_ROLES: 'dav', SUPERCAL_MIGRATE: 'off' };
    const proc = Bun.spawn(['bun', MAIN], { env, stdout: 'pipe', stderr: 'inherit' });
    daemon = proc;
    const port = await listeningPort(proc.stdout);

    const run = Bun.spawnSync(cmd, {
      env: { ...env, DAV_URL: `http://localhost:${port}/`, DAV_USER: ALICE.username, DAV_PASS: ALICE.password, MUTATE: join(here, 'mutate.ts'), WORKDIR: workdir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    console.log(`--- ${name}\n${output}`);
    return { exitCode: run.exitCode, output };
  } finally {
    daemon?.kill();
    await daemon?.exited;
    await rm(workdir, { recursive: true, force: true });
    await scratch.drop();
  }
}

/** Reads the daemon's JSON log until its `listening` line and returns the port. */
async function listeningPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stdout) {
    buffered += decoder.decode(chunk);
    for (const line of buffered.split('\n')) {
      const parsed: unknown = line.trim().startsWith('{') ? JSON.parse(line) : undefined;
      if (parsed && typeof parsed === 'object' && 'msg' in parsed && parsed.msg === 'listening' && 'port' in parsed) return Number(parsed.port);
    }
  }
  throw new Error('daemon exited before listening');
}

describe.skipIf(!testDatabaseUrl)('real CalDAV clients', () => {
  test('python caldav 3.7.0', async () => {
    const { exitCode, output } = await runClient('caldav', ['uv', 'run', '--quiet', '--with', 'caldav==3.7.0', 'python', join(here, 'caldav_lib.py')]);
    expect(output).toContain('OK');
    expect(exitCode).toBe(0);
  }, 120_000);

  test('vdirsyncer 0.19.3', async () => {
    const { exitCode, output } = await runClient('vdirsyncer', ['sh', join(here, 'vdirsyncer.sh')]);
    expect(output).toContain('OK');
    expect(exitCode).toBe(0);
  }, 300_000);

  test('tsdav smartCollectionSync', async () => {
    const { exitCode, output } = await runClient('tsdav', ['bun', join(here, 'tsdav.ts')]);
    expect(output).toContain('OK');
    expect(exitCode).toBe(0);
  }, 120_000);
});
