/**
 * Typed access to the management API, same origin so the session cookie applies. Screens read data
 * only through `$api` (`$api.useQuery('get', '/api/v1/me')`, `$api.queryOptions(…)`, `$api.useMutation(…)`).
 */
import { createClient, createQueryHooks, type Problem } from '@supercal/api-client';

export const client = createClient('/');
export const $api = createQueryHooks(client);

/** The problem body `$api` throws for a non-2xx response (network failures throw a `TypeError` instead). */
export const isProblem = (error: unknown): error is Problem =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' && 'title' in error;

/** React Query keys built by `$api` are `[method, path, init?]`; this is the path of one. */
export const keyPath = (key: readonly unknown[]): string => (typeof key[1] === 'string' ? key[1] : '');

/** The signed-in principal (`GET /api/v1/me`): user, active tenant, role and every membership. */
export const meQuery = $api.queryOptions('get', '/api/v1/me');
