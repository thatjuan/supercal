/**
 * Turns a failed connect or reconnect into what the form shows inline: one friendly message for
 * the known problem types (`invalid-credentials`, `unsupported-auth`, `egress-blocked`,
 * `provider-unavailable`), and per-field errors from a 400's `errors`.
 */
import { fieldErrors, toProblem } from '../ui/problem-alert.tsx';
import type { FormProvider } from './providers.tsx';

export type ConnectError = { message: string | null; fields: Partial<Record<string, string>> };

const slugOf = (type: string) => (type.startsWith('https://supercal.dev/problems/') ? type.slice('https://supercal.dev/problems/'.length) : null);

const INVALID_CREDENTIALS: Record<FormProvider, string> = {
  icloud: 'Apple rejected these credentials. Use an app-specific password, not your Apple ID password.',
  caldav: 'The server rejected this username or password.',
  ics: 'The calendar server refused this link. Check that it is the full private link and still valid.',
};

export function connectError(error: unknown, provider: FormProvider): ConnectError {
  const problem = toProblem(error);
  const fields = fieldErrors(problem);
  switch (slugOf(problem.type)) {
    case 'invalid-credentials':
      return { message: INVALID_CREDENTIALS[provider], fields };
    case 'unsupported-auth':
      return { message: 'This server only offers Digest sign-in, which Supercal does not support. Use a server or app password that allows Basic authentication.', fields };
    case 'egress-blocked':
      return { message: 'This server cannot reach private network addresses (such as your LAN or localhost) unless the operator allows them.', fields };
    case 'provider-unavailable':
      return { message: 'The calendar server did not answer. Try again in a minute.', fields };
  }
  if (problem.status === 400 && Object.keys(fields).length > 0) return { message: null, fields };
  return { message: problem.detail ?? problem.title, fields };
}
