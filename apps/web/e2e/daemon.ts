/**
 * Runs a real daemon for Playwright's web servers until it is told to stop: over a fresh
 * `<TEST_DATABASE_URL>_<database>` database, serving the built dashboard (`dist/`) same-origin,
 * exactly as in production. The database goes once the daemon exits.
 */
import { scratchDatabase } from '@supercal/db/test-db';

export async function serveDaemon({ port, database, env, preload, onStop }: { port: string; database: string; env: Record<string, string>; preload?: string; onStop?: () => void }) {
  const scratch = await scratchDatabase(database);
  const daemon = Bun.spawn(['bun', ...(preload ? ['--preload', preload] : []), new URL('../../daemon/src/main.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: port,
      DATABASE_URL: scratch.url,
      SUPERCAL_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SUPERCAL_INSECURE_DEV: '1',
      SUPERCAL_ROLES: 'api,dav,worker',
      SUPERCAL_WEB_DIR: new URL('../dist', import.meta.url).pathname,
      ...env,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  // Playwright signals the whole process group.
  const stop = () => {
    daemon.kill('SIGTERM');
    onStop?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const code = await daemon.exited;
  await scratch.drop();
  process.exit(code);
}
