/**
 * Runs one guarded fetch in a fresh process and prints the outcome as JSON. Trust roots and proxy
 * variables are process-wide, so the TLS and proxy tests vary them per child rather than in the
 * test process. Every hostname resolves to 127.0.0.1, which the target origin is allowed to reach.
 */
import { createGuardedFetch, EgressBlockedError } from '../../src/transport/index.ts';

export type Outcome =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: string | undefined; code: string | undefined; message: string };

/** Spawns this script with only `PATH` plus `env`, and returns the outcome it printed. */
export async function runChild(url: string, env: Record<string, string> = {}): Promise<Outcome> {
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { PATH: process.env.PATH ?? '', GUARDED_URL: url, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
  return JSON.parse(stdout);
}

if (import.meta.main) {
  const url = process.env.GUARDED_URL ?? '';
  const guardedFetch = createGuardedFetch(
    { allow: [{ origin: new URL(url).origin, cidrs: ['127.0.0.1/32'] }] },
    { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
  );
  let outcome: Outcome;
  try {
    const response = await guardedFetch({ url, timeoutMs: 2000 });
    outcome = { ok: true, status: response.status, body: new TextDecoder().decode(response.body) };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    outcome = { ok: false, reason: error instanceof EgressBlockedError ? error.reason : undefined, code, message: String(error) };
  }
  console.log(JSON.stringify(outcome));
}
