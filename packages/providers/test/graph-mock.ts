/**
 * A local stand-in for Microsoft Graph and its token endpoint, for tests. It holds one mailbox:
 * calendars, events per calendar (singles and series masters, each with its exceptions) and the
 * instances `/instances` lists. Every request is recorded; `intercept` (which may wait) answers
 * first when it returns a response. Point the adapter's `apiBase` at `${mock.url}/v1.0` and `tokenUrl` at
 * `${mock.url}/token` (`mock.options`).
 *
 *   const graph = mockGraph();
 *   graph.calendars.push({ id: 'cal-a', name: 'Work' });
 *   graph.put('cal-a', { id: 'e1', changeKey: 'k1', iCalUId: 'e1@x', … });
 */
import type { MicrosoftCredentials } from '../src/index.ts';

export type MockRequest = { method: string; path: string; query: URLSearchParams; body: string; headers: Headers };
type Json = Record<string, unknown>;

/** Credentials for `subject` whose access token is valid for an hour (or already expired). */
export const microsoftCredentials = (subject = 'tid-1:oid-1', { expired = false } = {}): MicrosoftCredentials => ({
  provider: 'microsoft',
  scopes: ['openid', 'email', 'offline_access', 'Calendars.ReadWrite', 'User.Read'],
  subject,
  email: 'ann@example.test',
  accessToken: 'access-1',
  accessTokenExpiresAt: new Date(Date.now() + (expired ? -1000 : 3_600_000)).toISOString(),
  refreshToken: 'refresh-1',
});

export function mockGraph({ pageSize = 100 }: { pageSize?: number } = {}) {
  const requests: MockRequest[] = [];
  const calendars: Json[] = [];
  /** Events by calendar id, then by event id; a master carries `exceptionOccurrences`. */
  const events = new Map<string, Map<string, Json>>();
  /** What `/me/events/{masterId}/instances` lists, by master id. */
  const instances = new Map<string, { id: string; originalStart: string }[]>();
  const subscriptions = new Map<string, Json>();
  let created = 0;
  const state = {
    intercept: (_req: MockRequest): Response | undefined | Promise<Response | undefined> => undefined,
    token: (_form: URLSearchParams): Response => Response.json({ access_token: 'access-refreshed', expires_in: 3600, refresh_token: 'refresh-rotated' }),
  };

  const find = (id: string): Json | undefined => {
    for (const calendar of events.values()) for (const event of calendar.values()) {
      if (event.id === id) return event;
      const exceptions = event.exceptionOccurrences;
      if (Array.isArray(exceptions)) { const found = exceptions.find((e: Json) => e.id === id); if (found) return found; }
      const slot = instances.get(String(event.id))?.find((i) => i.id === id);
      if (slot) return { ...event, id, changeKey: `instance-${id}`, type: 'occurrence', seriesMasterId: event.id, originalStart: slot.originalStart, recurrence: null, start: { dateTime: slot.originalStart.replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: new Date(Date.parse(slot.originalStart) + 3600000).toISOString().slice(0, 19), timeZone: 'UTC' } };
    }
    return undefined;
  };

  /** One page of `items` starting at `$skip`, with a nextLink when more remain. */
  function paged(url: URL, items: unknown[]): Response {
    const skip = Number(url.searchParams.get('$skip') ?? 0);
    const next = new URL(url);
    next.searchParams.set('$skip', String(skip + pageSize));
    return Response.json({ value: items.slice(skip, skip + pageSize), ...(skip + pageSize < items.length && { '@odata.nextLink': next.href }) });
  }

  function handle(url: URL, req: MockRequest): Response {
    if (req.path === '/token') return state.token(new URLSearchParams(req.body));
    if (req.path === '/v1.0/me/calendars') return paged(url, calendars);
    let match = req.path.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/events$/);
    if (match) {
      const calendarId = decodeURIComponent(match[1] ?? '');
      if (req.method === 'POST') {
        if (calendars.find((c) => c.id === calendarId)?.canEdit === false) return Response.json({ error: { code: 'ErrorAccessDenied' } }, { status: 403 });
        const body: Json = JSON.parse(req.body);
        const calendar = events.get(calendarId) ?? new Map<string, Json>();
        events.set(calendarId, calendar);
        const previous = [...calendar.values()].find((e) => e.transactionId === body.transactionId);
        if (previous) return Response.json(previous);
        const id = `created-${++created}`;
        const event = { ...body, id, changeKey: `key-${created}`, iCalUId: `${id}@outlook.test`, originalStartTimeZone: (body.start as { timeZone: string }).timeZone, type: body.recurrence ? 'seriesMaster' : 'singleInstance', exceptionOccurrences: [], cancelledOccurrences: [] };
        calendar.set(id, event);
        return Response.json(event, { status: 201 });
      }
      const items = [...(events.get(decodeURIComponent(match[1] ?? '')) ?? new Map<string, Json>()).values()];
      return paged(url, items.map(({ id, changeKey, type, seriesMasterId }) => ({ id, changeKey, type, seriesMasterId: seriesMasterId ?? null })));
    }
    match = req.path.match(/^\/v1\.0\/me\/events\/([^/]+)\/instances$/);
    if (match) return paged(url, instances.get(decodeURIComponent(match[1] ?? '')) ?? []);
    match = req.path.match(/^\/v1\.0\/me\/events\/([^/]+)$/);
    if (match) {
      const event = find(decodeURIComponent(match[1] ?? ''));
      if (!event) return Response.json({ error: { code: 'ErrorItemNotFound' } }, { status: 404 });
      if (req.method === 'GET') return Response.json(event);
      if (req.headers.get('if-match') !== `W/"${event.changeKey}"`) return Response.json({ error: { code: 'ErrorIrresolvableConflict' } }, { status: 412 });
      const master = event.seriesMasterId ? find(String(event.seriesMasterId)) : undefined;
      if (req.method === 'DELETE') {
        if (master) {
          master.cancelledOccurrences = [...(master.cancelledOccurrences as string[] ?? []), event.id];
          master.exceptionOccurrences = (master.exceptionOccurrences as Json[] ?? []).filter((e) => e.id !== event.id);
          master.changeKey = `key-${++created}`;
        } else for (const calendar of events.values()) calendar.delete(String(event.id));
        return new Response(null, { status: 204 });
      }
      Object.assign(event, JSON.parse(req.body), { changeKey: `key-${++created}` });
      if (master) {
        event.type = 'exception';
        master.exceptionOccurrences = [...(master.exceptionOccurrences as Json[] ?? []).filter((e) => e.id !== event.id), event];
        master.changeKey = `key-${++created}`;
      }
      return Response.json(event);
    }
    if (req.path === '/v1.0/subscriptions' && req.method === 'POST') {
      const subscription = { ...(JSON.parse(req.body) as Json), id: `sub-${++created}` };
      subscriptions.set(subscription.id, subscription);
      return Response.json(subscription, { status: 201 });
    }
    match = req.path.match(/^\/v1\.0\/subscriptions\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1] ?? '');
      const subscription = subscriptions.get(id);
      if (!subscription) return Response.json({ error: { code: 'ResourceNotFound' } }, { status: 404 });
      if (req.method === 'DELETE') return subscriptions.delete(id), new Response(null, { status: 204 });
      Object.assign(subscription, JSON.parse(req.body) as Json);
      return Response.json(subscription);
    }
    return new Response(null, { status: 404 });
  }

  const server = Bun.serve({
    port: 0,
    async fetch(raw) {
      const url = new URL(raw.url);
      const req = { method: raw.method, path: url.pathname, query: url.searchParams, body: await raw.text(), headers: raw.headers };
      requests.push(req);
      return (await state.intercept(req)) ?? handle(url, req);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    requests,
    calendars,
    instances,
    subscriptions,
    state,
    options: { clientId: 'client-id', clientSecret: 'client-secret', apiBase: `${url}/v1.0`, tokenUrl: `${url}/token` },
    /** Creates or replaces an event of `calendarId`. */
    put(calendarId: string, event: Json) {
      const calendar = events.get(calendarId) ?? new Map<string, Json>();
      events.set(calendarId, calendar);
      calendar.set(String(event.id), event);
    },
    remove(calendarId: string, id: string) {
      events.get(calendarId)?.delete(id);
    },
    /** Full fetches (`GET /me/events/{id}`) so far, by id. */
    fetched: () => requests.filter((r) => /^\/v1\.0\/me\/events\/[^/]+$/.test(r.path)).map((r) => decodeURIComponent(r.path.split('/').at(-1) ?? '')),
    stop: () => server.stop(true),
  };
}

/** A single event at `start` (UTC), an hour long. */
export const singleEvent = (id: string, changeKey: string, start = '2026-11-10T09:00:00') => ({
  id,
  changeKey,
  type: 'singleInstance',
  iCalUId: `${id}@example.test`,
  subject: `Event ${id}`,
  originalStartTimeZone: 'UTC',
  start: { dateTime: start, timeZone: 'UTC' },
  end: { dateTime: new Date(Date.parse(`${start}Z`) + 3_600_000).toISOString().slice(0, 19), timeZone: 'UTC' },
});

/** Weekly on Mondays 09:00 Pacific from 26 Oct 2026, five times; `extra` adds exceptions or cancellations. */
export const weeklySeries = (id: string, changeKey: string, extra: Json = {}) => ({
  id,
  changeKey,
  type: 'seriesMaster',
  iCalUId: `${id}@example.test`,
  subject: 'Team sync',
  originalStartTimeZone: 'Pacific Standard Time',
  start: { dateTime: '2026-10-26T16:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-26T17:00:00.0000000', timeZone: 'UTC' },
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday', dayOfMonth: 0, month: 0, index: 'first' },
    range: { type: 'numbered', startDate: '2026-10-26', endDate: '0001-01-01', numberOfOccurrences: 5, recurrenceTimeZone: 'Pacific Standard Time' },
  },
  cancelledOccurrences: [],
  exceptionOccurrences: [],
  ...extra,
});
