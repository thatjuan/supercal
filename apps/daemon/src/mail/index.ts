/**
 * Transactional email through Resend's HTTP API, enabled by `RESEND_API_KEY` and `MAIL_FROM`.
 * `createAuth` sends verification, password-reset, magic-link and invitation mail through it;
 * without a mailer those flows hand out copyable links instead.
 *
 *   const mailer = createMailer(config);            // null unless both variables are set
 *   await mailer?.send({ to, ...templates.verifyEmail({ url }) });
 */
import { z } from 'zod';

export const RESEND_URL = 'https://api.resend.com/emails';

export type Mail = { to: string; subject: string; text: string; html: string };

export type Mailer = { send(mail: Mail): Promise<void> };

const ResendError = z.object({ message: z.string() }).partial();

/** A mailer posting to Resend with `apiKey`, from `from` (`Name <addr@domain>` or a bare address). */
export function createResendMailer({ apiKey, from, fetch = globalThis.fetch }: { apiKey: string; from: string; fetch?: (url: string, init: RequestInit) => Promise<Response> }): Mailer {
  return {
    async send({ to, subject, text, html }) {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      const detail = ResendError.safeParse(await res.json().catch(() => null));
      throw new Error(`Resend refused the message (${res.status})${detail.success && detail.data.message ? `: ${detail.data.message}` : ''}`);
    },
  };
}

/** The configured mailer, or null when `RESEND_API_KEY` or `MAIL_FROM` is unset. */
export function createMailer(config: { RESEND_API_KEY?: string | undefined; MAIL_FROM?: string | undefined }): Mailer | null {
  return config.RESEND_API_KEY && config.MAIL_FROM ? createResendMailer({ apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM }) : null;
}
