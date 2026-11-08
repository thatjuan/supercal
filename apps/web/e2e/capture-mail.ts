/**
 * Preloaded into the daemon by `serve-verified.ts`: answers Resend's API locally and appends each
 * message to `E2E_MAIL_LOG` as a JSON line, so the real mailer runs and no mail leaves the machine.
 */
import { appendFileSync } from 'node:fs';

const log = process.env.E2E_MAIL_LOG;
if (!log) throw new Error('capture-mail needs E2E_MAIL_LOG');

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== 'https://api.resend.com/emails') return realFetch(input, init);
    appendFileSync(log, `${String(init?.body)}\n`);
    return Response.json({ id: 'captured' });
  },
  { preconnect: realFetch.preconnect },
);
