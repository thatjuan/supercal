/**
 * Stubs the network for component tests. Import it before anything that loads `api.ts`: the API
 * client binds `fetch` when it loads, and builds same-origin relative Requests jsdom cannot parse.
 */
import { vi } from 'vitest';

const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, 'http://localhost') : input, init);
  }
};

export const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
globalThis.fetch = (input: RequestInfo | URL) => fetchMock(input instanceof Request ? input : new Request(input));

/** Answers `GET`s from `routes` (pathname to JSON body) and anything else from `write`; every request is in `fetchMock.mock.calls`. */
export function respondWith(routes: Record<string, unknown>, write: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  fetchMock.mockImplementation(async (request) => {
    const body = request.method === 'GET' ? routes[new URL(request.url).pathname] : undefined;
    if (body !== undefined) return Response.json(body);
    return write(request);
  });
}

/** The requests made so far with this method. */
export const requests = (method: string) => fetchMock.mock.calls.map(([request]) => request).filter((request) => request.method === method);
