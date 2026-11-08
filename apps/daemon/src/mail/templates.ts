/**
 * The transactional mail Supercal sends: short plain text plus a matching minimal HTML part. Each
 * template returns `subject`, `text` and `html` for `Mailer.send`.
 */
type Message = { subject: string; text: string; html: string };

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** One message: paragraphs of text, then a link with `action` as its label. */
function message(subject: string, paragraphs: string[], action: string, url: string, footer: string): Message {
  const text = [...paragraphs, `${action}: ${url}`, footer].join('\n\n');
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:480px">',
    ...paragraphs.map((p) => `<p>${escape(p)}</p>`),
    `<p><a href="${escape(url)}" style="display:inline-block;padding:8px 16px;background:#1a1a1a;color:#fff;border-radius:6px;text-decoration:none">${escape(action)}</a></p>`,
    `<p style="font-size:13px;color:#666">${escape(footer)}</p>`,
    '</body></html>',
  ].join('');
  return { subject, text, html };
}

const IGNORE = 'If you did not ask for this, you can ignore this email.';

export const verifyEmail = ({ url }: { url: string }) =>
  message('Confirm your email for Supercal', ['Confirm your email address to finish setting up your Supercal account.'], 'Confirm email', url, IGNORE);

export const resetPassword = ({ url }: { url: string }) =>
  message('Reset your Supercal password', ['Someone asked to reset the password of your Supercal account. The link works once and expires in an hour.'], 'Choose a new password', url, IGNORE);

export const magicLink = ({ url }: { url: string }) =>
  message('Sign in to Supercal', ['Use this link to sign in to Supercal. It works once and expires in 5 minutes.'], 'Sign in', url, IGNORE);

export const invitation = ({ url, inviter, tenant }: { url: string; inviter: string; tenant: string }) =>
  message(`${inviter} invited you to ${tenant} on Supercal`, [`${inviter} invited you to join ${tenant} on Supercal, where you can combine your calendars into feeds.`], 'Accept invitation', url, 'The invitation expires in 48 hours. If you were not expecting it, you can ignore this email.');
