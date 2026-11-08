/** The root route: tooltips, the app-wide error boundary and the not-found page. Themes live in theme.ts and index.html. */
import { createRootRouteWithContext, Link, Outlet, type ErrorComponentProps } from '@tanstack/react-router';
import { ProblemAlert, toProblem } from '../components/ui/problem-alert.tsx';
import { TooltipProvider } from '../components/ui/tooltip.tsx';
import { Button } from '../components/ui/button.tsx';
import type { RouterContext } from '../router.tsx';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  ),
  errorComponent: RootError,
  notFoundComponent: NotFound,
});

function RootError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto grid max-w-md gap-3 px-4 py-16">
      <ProblemAlert problem={toProblem(error)} showFieldErrors />
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}

function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-[15px]">
      <h1 className="text-[22px] font-semibold tracking-tight">Page not found</h1>
      <p className="mt-1 text-ink-2">
        There is nothing at this address.{' '}
        <Link to="/" className="text-accent hover:underline">
          Go to Overview
        </Link>
      </p>
    </main>
  );
}
