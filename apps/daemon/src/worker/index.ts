import type { Logger } from '../log.ts';

/** Runs the worker role until `signal` aborts. Stub: the sync engine issue fills it. */
export async function startWorker(signal: AbortSignal, log: Logger): Promise<void> {
  log.info('worker started');
  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  log.info('worker stopped');
}
