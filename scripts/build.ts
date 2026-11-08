/**
 * `bun run build`: embeds the migrations, builds the dashboard, and compiles the daemon into
 * `dist/supercal` with the dashboard beside it in `dist/web` (where the binary looks by default).
 * On macOS the binary is re-signed ad hoc, without which the first launch is killed.
 */
import { $ } from 'bun';
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
$.cwd(root);

await $`bun run --cwd packages/db embed`;
await $`bun run --cwd apps/web build`;
await rm(join(root, 'dist'), { recursive: true, force: true });
await $`bun build --compile --minify apps/daemon/src/main.ts --outfile dist/supercal`;
await cp(join(root, 'apps/web/dist'), join(root, 'dist/web'), { recursive: true });
if (process.platform === 'darwin') await $`codesign --force --sign - dist/supercal`;
console.log(`built dist/supercal (${((await Bun.file(join(root, 'dist/supercal')).stat()).size / 1e6).toFixed(1)} MB) and dist/web`);
