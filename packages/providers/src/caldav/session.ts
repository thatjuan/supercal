/**
 * One account's WebDAV conversation. tsdav builds the XML and parses the multistatus; its injected
 * `fetch` is a shim over the guarded transport, so every request is SSRF-checked, bounded and
 * IP-pinned. tsdav types its results loosely, so each one is validated here with Zod before the
 * adapter sees it. Credentials go only to the account's own hosts.
 *
 *   const dav = createDavSession(ctx, { username, password, hosts: ['caldav.icloud.com', '*.icloud.com'] });
 *   const { entries, url } = await dav.propfind(home, ['d:displayname'], '1');
 */
import { davRequest, propfind, syncCollection, type DAVResponse } from 'tsdav';
import { z } from 'zod';
import { AuthFailedError, ProviderThrottledError, ProviderUnavailableError, type AdapterContext } from '../adapter.ts';
import { EgressBlockedError, hostMatches, type GuardedResponse } from '../transport/index.ts';

/** The server only offers an auth scheme we do not support (v1 is Basic only). */
export class UnsupportedAuthError extends AuthFailedError {}

/** A non-2xx answer the caller asked to handle itself (see `handled`). */
export class DavStatusError extends Error {
  override readonly name = 'DavStatusError';
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`DAV HTTP ${status}`);
  }
}

/** One `<response>` of a multistatus, with an absolute href. */
export type DavEntry = { href: string; status: number; props: Record<string, unknown> };
export type DavResult = { url: string; entries: DavEntry[]; syncToken: string | null };

const NS = {
  'xmlns:d': 'DAV:',
  'xmlns:c': 'urn:ietf:params:xml:ns:caldav',
  'xmlns:cs': 'http://calendarserver.org/ns/',
  'xmlns:ca': 'http://apple.com/ns/ical/',
};

/** XML text as xml-js leaves it: a string, or `{_text}` / `{_cdata}`. */
export const Text = z.union([z.string(), z.object({ _text: z.string() }).transform((t) => t._text), z.object({ _cdata: z.string() }).transform((t) => t._cdata)]);

const Entry = z.object({
  href: Text.optional(),
  status: z.number(),
  props: z.record(z.string(), z.unknown()).optional(),
  raw: z.unknown(),
  parseError: z.string().optional(),
});
const Multistatus = z.object({ multistatus: z.object({ syncToken: Text.optional() }).loose() }).loose();

/** Maps an HTTP failure to the adapter error the runner understands. Never a deletion. */
function statusError(response: GuardedResponse): Error {
  const { status, headers } = response;
  if (status === 401) {
    const challenge = headers.get('www-authenticate') ?? '';
    if (challenge && !/\bbasic\b/i.test(challenge)) return new UnsupportedAuthError(`the server only offers ${challenge.split(/\s/)[0]} authentication; only Basic is supported`);
    return new AuthFailedError(`the server rejected the credentials (HTTP ${status})`);
  }
  if (status === 403) return new AuthFailedError('the server refused access (HTTP 403)');
  if (status === 429 || (status === 503 && headers.has('retry-after'))) {
    const seconds = Number(headers.get('retry-after'));
    return new ProviderThrottledError(seconds > 0 ? seconds * 1000 : 60_000);
  }
  return new ProviderUnavailableError(`the CalDAV server answered HTTP ${status}`);
}

export function createDavSession(ctx: AdapterContext, { username, password, hosts }: { username: string; password: string; hosts: string[] }) {
  const guarded = ctx.fetch;

  /** Runs one tsdav call over the guarded transport and validates its result. `handled` statuses throw `DavStatusError` instead of an adapter error. */
  async function exchange(url: string, send: (shim: typeof globalThis.fetch) => Promise<DAVResponse[]>, handled: number[] = []): Promise<DavResult> {
    const host = new URL(url).hostname;
    if (!hostMatches(host, hosts)) throw new ProviderUnavailableError(`the server referred to ${host}, which is not one of this account's hosts`);
    let last: GuardedResponse | undefined;
    const shim = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method;
        if (method !== 'PROPFIND' && method !== 'REPORT') throw new Error(`CalDAV sync is read-only; refused ${method}`);
        const response = await guarded({
          url: String(input),
          method,
          headers: Object.fromEntries(new Headers(init?.headers)),
          ...(typeof init?.body === 'string' && { body: init.body }),
          credentials: { kind: 'basic', username, password },
          credentialHosts: hosts,
          signal: ctx.signal,
        }).catch((error: unknown) => {
          if (error instanceof EgressBlockedError || ctx.signal.aborted) throw error;
          throw new ProviderUnavailableError(`could not reach ${host}`, { cause: error });
        });
        last = response;
        const result = new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
        Object.defineProperty(result, 'url', { value: response.finalUrl });
        return result;
      },
      { preconnect: () => {} },
    );

    const raw = await send(shim);
    if (!last) throw new Error('tsdav made no request');
    const http = last;
    if (http.status < 200 || http.status >= 300) {
      if (handled.includes(http.status)) throw new DavStatusError(http.status, new TextDecoder().decode(http.body));
      throw statusError(http);
    }

    const parsed = z.array(Entry).safeParse(raw);
    if (!parsed.success) throw new ProviderUnavailableError('the CalDAV server sent an unreadable multistatus');
    const entries: DavEntry[] = [];
    let syncToken: string | null = null;
    for (const entry of parsed.data) {
      // Unparsed text (malformed XML, or not XML at all) is never read as "no objects".
      if (entry.parseError !== undefined || typeof entry.raw === 'string') throw new ProviderUnavailableError('the CalDAV server sent malformed XML');
      const root = Multistatus.safeParse(entry.raw);
      if (!root.success) throw new ProviderUnavailableError('the CalDAV server sent no multistatus');
      syncToken = root.data.multistatus.syncToken ?? syncToken;
      // tsdav represents an empty multistatus as one entry without an href.
      if (entry.href === undefined) continue;
      entries.push({ href: new URL(entry.href, http.finalUrl).href, status: entry.status, props: entry.props ?? {} });
    }
    return { url: http.finalUrl, entries, syncToken };
  }

  return {
    /** PROPFIND for `props` (prefixed names such as `d:displayname`, `c:calendar-home-set`). */
    propfind: (url: string, props: string[], depth: '0' | '1', handled?: number[]) =>
      exchange(url, (shim) => propfind({ url, props: Object.fromEntries(props.map((p) => [p, {}])), depth, fetch: shim }), handled),

    /** RFC 6578 sync-collection REPORT for etags; `token` '' starts from scratch. */
    syncCollection: (url: string, token: string, handled?: number[]) =>
      exchange(url, (shim) => syncCollection({ url, props: { 'd:getetag': {} }, syncLevel: 1, syncToken: token, headers: { depth: '1' }, fetch: shim }), handled),

    /** calendar-multiget for etags and calendar data of `paths` (absolute paths). */
    multiget: (url: string, paths: string[]) =>
      exchange(url, (shim) =>
        davRequest({
          url,
          init: {
            method: 'REPORT',
            headers: { depth: '1' },
            body: { 'c:calendar-multiget': { _attributes: NS, 'd:prop': { 'd:getetag': {}, 'c:calendar-data': {} }, 'd:href': paths } },
          },
          fetch: shim,
        }),
      ),
  };
}

export type DavSession = ReturnType<typeof createDavSession>;
