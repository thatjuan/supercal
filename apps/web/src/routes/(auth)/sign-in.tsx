import type { Problem } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { authClient } from '../../auth.ts';
import { AuthLayout } from '../../components/auth-layout.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Field } from '../../components/ui/field.tsx';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';
import { redirectSearch } from '../../lib/redirect.ts';

export const Route = createFileRoute('/(auth)/sign-in')({ validateSearch: redirectSearch, component: SignIn });

function SignIn() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const { error } = await authClient.signIn.email({ email: String(form.get('email')), password: String(form.get('password')) });
    setPending(false);
    if (error) return setProblem(toProblem(error));
    queryClient.clear();
    await navigate({ to: redirect ?? '/' });
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="One calm view of all your calendars."
      footer={
        <>
          New here?{' '}
          <Link to="/sign-up" search={redirect ? { redirect } : {}} className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3">
        {problem && <ProblemAlert problem={problem} />}
        <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required />
        <Button type="submit" variant="primary" disabled={pending} className="mt-1">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  );
}
