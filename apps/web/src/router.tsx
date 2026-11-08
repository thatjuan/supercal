import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.ts';

/** Route context: every loader and `beforeLoad` can prefetch through the app's QueryClient. */
export type RouterContext = { queryClient: QueryClient };

export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent', defaultPreloadStaleTime: 0, scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
