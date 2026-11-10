/**
 * A local stand-in for Google's API and token endpoints, for tests: every request is recorded and
 * answered by `handle`. Point the adapter's `apiBase` at `${mock.url}/calendar/v3` and `tokenUrl`
 * at `${mock.url}/token`.
 *
 *   const mock = mockGoogle((req) => (req.path === '/token' ? Response.json(token()) : new Response(null, { status: 404 })));
 */
import { Temporal } from '@js-temporal/polyfill';
import type { GoogleTime } from '@supercal/core';
import { StoredGoogleEvent, googleSlot, googleInstanceId, type GoogleCredentials } from '../src/index.ts';

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

/** Stateful event endpoints shared by adapter and daemon tests, with conditional writes and generated instances. */
export function googleEventStore() {
  const events = new Map<string, StoredGoogleEvent>();
  const instanceIds = new Map<string, string>();
  let revision = 0;
  let writes = 0;
  const hooks: { beforeWrite?: (req: MockRequest, count: number) => Response | undefined } = {};

  /** Google responses always include an offset on dateTime, even when writes used a zone and wall time. */
  function stored(input: unknown): StoredGoogleEvent {
    const event = StoredGoogleEvent.parse(input);
    for (const key of ['start', 'end', 'originalStartTime'] as const) {
      const time = event[key];
      if (time?.dateTime) event[key] = { ...time, dateTime: googleSlot(time) };
    }
    return event;
  }

  /** Generate an unmodified occurrence of an existing recurring master. */
  function instance(masterId: string, original: GoogleTime): StoredGoogleEvent | undefined {
    const master = events.get(masterId);
    if (!master?.recurrence?.length || !master.start || !master.end) return undefined;
    const deterministic = googleInstanceId(masterId, original);
    const id = instanceIds.get(deterministic) ?? deterministic;
    const known = events.get(id);
    if (known) return known;
    const start = googleSlot(original);
    let end: GoogleTime;
    if (original && 'date' in original && master.start.date && master.end.date) end = { date: Temporal.PlainDate.from(original.date).add(Temporal.PlainDate.from(master.start.date).until(master.end.date)).toString() };
    else end = { dateTime: Temporal.Instant.from(start).add({ seconds: (Date.parse(googleSlot(master.end)) - Date.parse(googleSlot(master.start))) / 1000 }).toString(), ...(master.start.timeZone && { timeZone: master.start.timeZone }) };
    const { recurrence: _recurrence, ...fields } = master;
    const event = stored({ ...fields, id, etag: `"instance-${++revision}"`, recurringEventId: masterId, originalStartTime: original, start: original, end });
    events.set(id, event);
    return event;
  }

  /** Handle one event route, returning undefined for routes belonging to the surrounding mock. */
  function handle(req: MockRequest): Response | undefined {
    const match = /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/]+))?(?:\/(instances))?$/.exec(req.path);
    if (!match) return undefined;
    const id = match[1] ? decodeURIComponent(match[1]) : undefined;
    if (req.method !== 'GET') {
      const failure = hooks.beforeWrite?.(req, ++writes);
      if (failure) return failure;
    }
    if (id === 'import' && req.method === 'POST') {
      const event = stored({ ...JSON.parse(req.body), id: `imported${++revision}`, etag: `"${revision}"`, organizer: { self: true } });
      events.set(event.id, event);
      return Response.json(event);
    }
    if (!id) return Response.json({ items: [...events.values()], nextSyncToken: `token-${revision}` });
    if (match[2]) {
      const min = req.query.get('timeMin');
      if (!min) return Response.json({ items: [] });
      const at = Temporal.Instant.from(min).add({ hours: 24 });
      const master = events.get(id);
      const original: GoogleTime = master?.start?.date ? { date: at.toString().slice(0, 10) } : { dateTime: at.toString(), ...(master?.start?.timeZone && { timeZone: master.start.timeZone }) };
      const event = instance(id, original);
      return Response.json({ items: event ? [event] : [] });
    }
    let event = events.get(id);
    if (!event) {
      const parts = /^(.*)_(\d{8})(?:T(\d{6})Z)?$/.exec(id);
      if (parts?.[1] && parts[2] && !instanceIds.has(id)) {
        const date = `${parts[2].slice(0, 4)}-${parts[2].slice(4, 6)}-${parts[2].slice(6, 8)}`;
        event = instance(parts[1], parts[3] ? { dateTime: `${date}T${parts[3].slice(0, 2)}:${parts[3].slice(2, 4)}:${parts[3].slice(4, 6)}Z` } : { date });
      }
    }
    if (!event) return new Response(null, { status: 404 });
    if (req.method === 'GET') return Response.json(event);
    const condition = req.headers.get('if-match');
    if ((condition !== null && condition !== event.etag) || (condition === null && !event.recurringEventId)) return new Response(null, { status: 412 });
    if (req.method === 'PATCH') {
      const changed = stored({ ...event, ...JSON.parse(req.body), etag: `"${++revision}"` });
      events.set(id, changed);
      return Response.json(changed);
    }
    if (req.method === 'DELETE') {
      for (const [key, item] of events) if (key === id || item.recurringEventId === id) events.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }
  return { events, instanceIds, hooks, handle };
}
