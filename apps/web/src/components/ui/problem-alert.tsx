/**
 * RFC 9457 problems in the UI. `toProblem` turns whatever a request threw (an `$api` problem, a
 * Better Auth error, a network failure) into a `Problem`; `ProblemAlert` renders it; `fieldErrors`
 * maps its per-field `errors` onto form fields by path.
 */
import type { Problem } from '@supercal/api-client';
import { isProblem } from '../../api.ts';
import { cx } from './cx.ts';

/** A Problem for anything thrown by `$api` or returned as `error` by the Better Auth client. */
export function toProblem(error: unknown): Problem {
  if (isProblem(error)) return error;
  if (error instanceof TypeError) return { type: 'about:blank', title: 'Network error', status: 0, detail: 'Supercal could not be reached. Check your connection.' };
  const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : undefined;
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500;
  return { type: 'about:blank', title: message ?? 'Something went wrong', status };
}

/** `problem.errors` keyed by field path (`{ email: 'Invalid email' }`), for `Field`'s `error`. */
export const fieldErrors = (problem: Problem | null | undefined): Partial<Record<string, string>> =>
  Object.fromEntries((problem?.errors ?? []).map((error) => [error.path, error.message]));

/** Shows a problem's title and detail. Field errors render on their fields instead, so they are listed only when unmapped. */
export function ProblemAlert({ problem, className, showFieldErrors = false }: { problem: Problem; className?: string; showFieldErrors?: boolean }) {
  return (
    <div role="alert" className={cx('rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger', className)}>
      <p className="font-medium">{problem.title}</p>
      {problem.detail && problem.detail !== problem.title && <p className="mt-0.5 opacity-90">{problem.detail}</p>}
      {showFieldErrors && problem.errors && problem.errors.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {problem.errors.map((error) => (
            <li key={error.path}>
              <span className="font-mono text-xs">{error.path}</span> {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
