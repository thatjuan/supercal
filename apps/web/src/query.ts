/** The app's QueryClient: data stays fresh for 30 s, and only server errors (5xx) are retried. */
import { QueryClient } from '@tanstack/react-query';
import { isProblem } from './api.ts';

const MAX_RETRIES = 3;

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failures, error) => failures < MAX_RETRIES && isProblem(error) && error.status >= 500,
      },
    },
  });
