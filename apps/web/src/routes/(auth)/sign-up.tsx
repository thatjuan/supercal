import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { $api } from '../../api.ts';
import { AuthLayout } from '../../components/auth-layout.tsx';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';
import { redirectSearch } from '../../lib/redirect.ts';
import { CheckEmail, SignUpForm } from './-sign-up-form.tsx';

export const Route = createFileRoute('/(auth)/sign-up')({ validateSearch: redirectSearch, component: SignUp });

const CLOSED_MESSAGE = {
  invite: 'This server is invite-only. Ask a tenant admin for an invitation link; it brings you back here to finish.',
  disabled: 'Sign-up is turned off on this server. Ask its operator to create an account for you.',
} as const;

function SignUp() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const instance = $api.useQuery('get', '/api/v1/instance');
  const [confirming, setConfirming] = useState<string | null>(null);

  const footer = (
    <>
      Already have an account?{' '}
      <Link to="/sign-in" search={redirect ? { redirect } : {}} className="font-medium text-accent hover:underline">
        Sign in
      </Link>
    </>
  );

  // Ahead of the instance checks: the first user's sign-up ends `setupRequired`, so the next refetch closes sign-up.
  if (confirming) return <CheckEmail email={confirming} />;

  if (instance.error) {
    return (
      <AuthLayout title="Create an account" footer={footer}>
        <ProblemAlert problem={toProblem(instance.error)} />
      </AuthLayout>
    );
  }
  if (!instance.data) return <AuthLayout title="Create an account">{null}</AuthLayout>;

  const { signup, setupRequired } = instance.data;
  if (signup !== 'open' && !setupRequired) {
    return (
      <AuthLayout title="Sign-up is closed" footer={footer}>
        <p className="text-[15px] text-ink-2">{CLOSED_MESSAGE[signup]}</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={setupRequired ? 'Set up Supercal' : 'Create an account'}
      subtitle={setupRequired ? 'You are the first user, so you will be this server’s operator.' : 'You get a personal tenant to start in.'}
      footer={footer}
    >
      <SignUpForm
        {...(redirect ? { callbackURL: redirect } : {})}
        onConfirmationSent={setConfirming}
        onSignedUp={async () => {
          queryClient.clear();
          await navigate({ to: redirect ?? '/' });
        }}
      />
    </AuthLayout>
  );
}
