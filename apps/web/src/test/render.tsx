import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

/** Renders `ui` inside React Query and a router, for components with `Link`s, and resolves once it shows. */
export async function renderApp(ui: ReactElement) {
  vi.stubGlobal('scrollTo', () => {});
  const rootRoute = createRootRoute({ component: () => <div data-testid="app">{ui}</div> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByTestId('app');
  return { queryClient };
}
