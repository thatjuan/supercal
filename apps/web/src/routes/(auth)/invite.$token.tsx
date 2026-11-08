/**
 * An invitation link (`/invite/<invitation id>`). Signed in, it accepts the invitation and switches
 * to that tenant; signed out, it offers sign-up with the invitation (which `invite` mode requires)
 * or sign-in, which returns here.
 */
import type { Problem } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { authClient } from '../../auth.ts';
import { AuthLayout } from '../../components/auth-layout.tsx';
import { Button } from '../../components/ui/button.tsx';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';
import { SignUpForm } from './-sign-up-form.tsx';

export const Route = createFileRoute('/(auth)/invite/$token')({ component: Invite });

function Invite() {
  const { token } = Route.useParams();
  const session = authClient.useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);

  /** Accepts the invitation, makes its tenant active and opens the dashboard there. */
  async function accept() {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: token });
    if (error) throw error;
    const active = await authClient.organization.setActive({ organizationId: data.member.organizationId });
    if (active.error) throw active.error;
    queryClient.clear();
    await navigate({ to: '/' });
  }

  if (session.isPending) return <AuthLayout title="Invitation">{null}</AuthLayout>;

  if (session.data) {
    return (
      <AuthLayout title="Join a tenant" subtitle={`You are signed in as ${session.data.user.email}.`}>
        <div className="grid gap-3">
          {problem && <ProblemAlert problem={problem} />}
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => {
              setPending(true);
              accept()
                .catch((failure: unknown) => setProblem(toProblem(failure)))
                .finally(() => setPending(false));
            }}
          >
            {pending ? 'Joining…' : 'Accept invitation'}
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="You’re invited"
      subtitle="Create your account to join. Use the email address the invitation was sent to."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/sign-in" search={{ redirect: `/invite/${token}` }} className="font-medium text-accent hover:underline">
            Sign in to accept
          </Link>
        </>
      }
    >
      <SignUpForm invitationId={token} submitLabel="Create account and join" onSignedUp={accept} />
    </AuthLayout>
  );
}
