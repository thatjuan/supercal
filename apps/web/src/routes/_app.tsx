/**
 * The signed-in layout: requires a session (else sign-in, returning here), mounts the live stream
 * once, and frames every dashboard screen with the sidebar.
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { isProblem, meQuery } from '../api.ts';
import { authClient } from '../auth.ts';
import { AuthLayout } from '../components/auth-layout.tsx';
import { Sidebar } from '../components/shell/sidebar.tsx';
import { Button } from '../components/ui/button.tsx';
import { ProblemAlert, toProblem } from '../components/ui/problem-alert.tsx';
import { useLiveUpdates } from '../live.ts';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (isProblem(error) && error.status === 401) throw redirect({ to: '/sign-in', search: { redirect: location.href } });
      // A 403 (signed in, but no tenant) renders below; anything else is the error boundary's.
      if (!isProblem(error) || error.status !== 403) throw error;
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const me = useQuery(meQuery);
  const live = useLiveUpdates(me.data?.tenant.id);

  if (me.error) return <NoTenant error={me.error} />;
  if (!me.data) return null;

  return (
    <div className="flex h-full">
      <Sidebar me={me.data} live={live} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 pt-12 pb-10 lg:pl-10">
        <Outlet />
      </main>
    </div>
  );
}

/** Signed in but in no tenant (removed from all of them, or created without one by an operator). */
function NoTenant({ error }: { error: unknown }) {
  return (
    <AuthLayout title="No tenant yet" subtitle="Your account is not a member of any tenant. Ask an admin for an invitation link.">
      <div className="grid gap-3">
        <ProblemAlert problem={toProblem(error)} />
        <Button onClick={() => void authClient.signOut().then(() => window.location.assign('/sign-in'))}>Sign out</Button>
      </div>
    </AuthLayout>
  );
}
