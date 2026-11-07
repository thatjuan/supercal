/**
 * @supercal/api-client: the typed management API client. `schema.ts` is generated from
 * `openapi.json` (`bun run api:spec && bun run api:client`); never edit either by hand.
 */
import createFetchClient from 'openapi-fetch';
import createQueryClient from 'openapi-react-query';
import type { components, paths } from './schema.ts';

export type { components, operations, paths } from './schema.ts';
export type Problem = components['schemas']['Problem'];

/** A fetch client for the API at `baseUrl` (`''` for same origin, where the session cookie applies). */
export const createClient = (baseUrl: string, fetch?: typeof globalThis.fetch) =>
  createFetchClient<paths>({ baseUrl, ...(fetch && { fetch }) });

export type ApiClient = ReturnType<typeof createClient>;

/** React Query hooks and query options (`useQuery`, `useMutation`, `queryOptions`) over `client`. */
export const createQueryHooks = (client: ApiClient) => createQueryClient(client);
