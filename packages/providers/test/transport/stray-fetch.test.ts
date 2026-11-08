import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const SCANNED = ['packages/providers/src', 'apps/daemon/src/sync'];
// The transport itself, plus the Google and Graph clients and the OAuth token calls, which only reach fixed Google/Microsoft hosts.
const EXEMPT = ['packages/providers/src/transport/', 'packages/providers/src/google/', 'packages/providers/src/microsoft/', 'packages/providers/src/oauth.ts'];
const FETCH_CALL = /\bfetch\s*\(/;

test('user-influenced code fetches only through the guarded transport', async () => {
  expect(FETCH_CALL.test(await Bun.file(join(ROOT, 'packages/providers/src/transport/guarded-fetch.ts')).text())).toBe(true);
  const offenders: string[] = [];
  for (const dir of SCANNED.filter((d) => existsSync(join(ROOT, d)))) {
    for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: join(ROOT, dir) })) {
      const path = `${dir}/${file}`;
      if (path.endsWith('.test.ts') || EXEMPT.some((prefix) => path.startsWith(prefix))) continue;
      if (FETCH_CALL.test(await Bun.file(join(ROOT, path)).text())) offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
