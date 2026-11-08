import type { Problem } from '@supercal/api-client';
import { useState, type FormEvent } from 'react';
import { authClient } from '../../auth.ts';
import { Button } from '../../components/ui/button.tsx';
import { Field } from '../../components/ui/field.tsx';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';

const MIN_PASSWORD = 8;

/**
 * Name, email and password, posted to Better Auth's email sign-up. `invitationId` goes along for
 * `invite` mode, where the server checks it against a pending invitation for that email.
 * `onSignedUp` runs once the new session exists.
 */
export function SignUpForm({ invitationId, submitLabel = 'Create account', onSignedUp }: { invitationId?: string; submitLabel?: string; onSignedUp: () => Promise<unknown> }) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
      // Better Auth merges `fetchOptions.body` into the request body; its typed input has no room for extra fields.
      ...(invitationId && { fetchOptions: { body: { invitationId } } }),
    });
    if (error) {
      setPending(false);
      return setProblem(toProblem(error));
    }
    try {
      await onSignedUp();
    } catch (failure) {
      setProblem(toProblem(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      {problem && <ProblemAlert problem={problem} />}
      <Field label="Name" name="name" autoComplete="name" required autoFocus />
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required hint={`At least ${MIN_PASSWORD} characters.`} />
      <Button type="submit" variant="primary" disabled={pending} className="mt-1">
        {pending ? 'Creating account…' : submitLabel}
      </Button>
    </form>
  );
}
