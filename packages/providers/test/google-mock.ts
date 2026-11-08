/**
 * A local stand-in for Google's API and token endpoints, for tests: every request is recorded and
 * answered by `handle`. Point the adapter's `apiBase` at `${mock.url}/calendar/v3` and `tokenUrl`
 * at `${mock.url}/token`.
 *
 *   const mock = mockGoogle((req) => (req.path === '/token' ? Response.json(token()) : new Response(null, { status: 404 })));
 */
import type { GoogleCredentials } from '../src/index.ts';

export type MockRequest = { method: string; path: string; query: URLSearchParams; body: string; headers: Headers };

export function mockGoogle(handle: (req: MockRequest) => Response | Promise<Response>) {
  const requests: MockRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(raw) {
      const url = new URL(raw.url);
      const req = { method: raw.method, path: url.pathname, query: url.searchParams, body: await raw.text(), headers: raw.headers };
      requests.push(req);
      return handle(req);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    requests,
    options: { clientId: 'client-id', clientSecret: 'client-secret', apiBase: `${url}/calendar/v3`, tokenUrl: `${url}/token`, ratePerSecond: 1000 },
    stop: () => server.stop(true),
  };
}

/** Credentials for `sub` whose access token is valid for an hour (or already expired). */
export const googleCredentials = (sub = 'sub-1', { expired = false } = {}): GoogleCredentials => ({
  provider: 'google',
  sub,
  email: `${sub}@example.test`,
  accessToken: 'access-1',
  accessTokenExpiresAt: new Date(Date.now() + (expired ? -1000 : 3_600_000)).toISOString(),
  refreshToken: 'refresh-1',
  scopes: ['openid', 'email'],
});
