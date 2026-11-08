/**
 * Calls to Microsoft Graph v1.0 for one mailbox: at most 4 concurrent requests per account (the
 * Outlook limit), access-token refresh within 60 s of expiry (refresh tokens rotate, so the new one
 * is always saved through `ctx.saveCredentials`, which compare-and-swaps), and Graph's errors mapped
 * onto the adapter contract. Every request asks for UTC times and immutable ids. Graph is a fixed
 * host, so these use plain `fetch`, not the guarded transport.
 */
import { z } from 'zod';
import { AuthFailedError, ProviderThrottledError, ProviderUnavailableError, type AdapterContext } from '../adapter.ts';
import type { MicrosoftCredentials } from '../credentials.ts';
import { OAuthError, tokenRequest } from '../oauth.ts';

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';
/** The `common` authority: personal (Outlook.com) and work or school accounts. */
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const MICROSOFT_TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`;
export const MICROSOFT_SCOPES = ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Calendars.Read', 'https://graph.microsoft.com/User.Read'];

/** Shown as the account's `status_detail` when Microsoft refuses the refresh token. */
export const MICROSOFT_REAUTH_DETAIL = 'Microsoft rejected the refresh token, so the account needs to be reconnected.';

const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const PREFER = 'outlook.timezone="UTC", IdType="ImmutableId"';
/** Token errors that mean the user has to sign in again. */
const REAUTH_ERRORS = new Set(['invalid_grant', 'interaction_required']);

export type MicrosoftClientOptions = {
  clientId: string;
  clientSecret: string;
  /** Overridden in tests to point at a local mock. */
  apiBase?: string;
  tokenUrl?: string;
  /** Concurrent requests per account. */
  concurrency?: number;
};

/** A non-2xx answer the caller may handle by status (404 on a deleted event or subscription). */
export class GraphHttpError extends ProviderUnavailableError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Milliseconds from a Retry-After header (seconds or an HTTP date). */
function retryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - Date.now());
}

function microsoftCredentials(ctx: AdapterContext): MicrosoftCredentials {
  if (ctx.credentials.provider !== 'microsoft') throw new AuthFailedError(`expected Microsoft credentials, got ${ctx.credentials.provider}`);
  return ctx.credentials;
}

/** A counting semaphore per key: `run(key, fn)` runs at most `limit` of one key's calls at once. */
function createSemaphore(limit: number) {
  const slots = new Map<string, { active: number; waiting: (() => void)[] }>();
  return async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const slot = slots.get(key) ?? { active: 0, waiting: [] };
    slots.set(key, slot);
    if (slot.active >= limit) await new Promise<void>((resolve) => slot.waiting.push(resolve));
    slot.active++;
    try {
      return await fn();
    } finally {
      slot.active--;
      const next = slot.waiting.shift();
      if (next) next();
      else if (slot.active === 0) slots.delete(key);
    }
  };
}

const Page = z.object({ value: z.array(z.unknown()), '@odata.nextLink': z.string().optional() });

export type GraphApi = ReturnType<typeof createGraphApi>;

export function createGraphApi({ clientId, clientSecret, apiBase = GRAPH_API, tokenUrl = MICROSOFT_TOKEN_URL, concurrency = 4 }: MicrosoftClientOptions) {
  const slot = createSemaphore(concurrency);
  const apiOrigin = new URL(apiBase).origin;
  // One refresh at a time per context, so parallel requests do not each spend the rotating refresh token.
  const refreshing = new WeakMap<AdapterContext, Promise<string>>();

  async function refresh(ctx: AdapterContext): Promise<string> {
    const credentials = microsoftCredentials(ctx);
    let token;
    try {
      token = await tokenRequest(
        tokenUrl,
        { grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: clientId, client_secret: clientSecret, scope: MICROSOFT_SCOPES.join(' ') },
        ctx.signal,
      );
    } catch (error) {
      if (error instanceof OAuthError && REAUTH_ERRORS.has(error.code)) throw new AuthFailedError(MICROSOFT_REAUTH_DETAIL);
      if (error instanceof OAuthError) throw new ProviderUnavailableError(`Microsoft token refresh failed: ${error.message}`);
      throw error;
    }
    await ctx.saveCredentials({
      ...credentials,
      accessToken: token.access_token,
      accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      refreshToken: token.refresh_token ?? credentials.refreshToken,
    });
    return token.access_token;
  }

  /** A usable access token, refreshed (and saved) when it expires within a minute or `force` is set. */
  async function accessToken(ctx: AdapterContext, force = false): Promise<string> {
    const credentials = microsoftCredentials(ctx);
    if (!force && Date.parse(credentials.accessTokenExpiresAt) - Date.now() > REFRESH_MARGIN_MS) return credentials.accessToken;
    let pending = refreshing.get(ctx);
    if (!pending) {
      pending = refresh(ctx).finally(() => refreshing.delete(ctx));
      refreshing.set(ctx, pending);
    }
    return pending;
  }

  /**
   * Calls `path` (relative to the API base, or an `@odata.nextLink` on the API's origin) and parses
   * the JSON answer with `schema`. A 401 refreshes the token and retries once; 429 and 503 become
   * `ProviderThrottledError`, and any other failure a `GraphHttpError`.
   */
  async function call<S extends z.ZodType>(
    ctx: AdapterContext,
    schema: S,
    path: string,
    { method = 'GET', query, body }: { method?: string; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(path.startsWith('https://') || path.startsWith('http://') ? path : apiBase + path);
    // Never send the token anywhere but Graph, whatever a nextLink says.
    if (url.origin !== apiOrigin) throw new ProviderUnavailableError(`Graph pointed at another origin (${url.origin})`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const key = microsoftCredentials(ctx).subject;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(ctx, attempt > 0);
      const res = await slot(key, () =>
        fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', prefer: PREFER, ...(body !== undefined && { 'content-type': 'application/json' }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: ctx.signal,
        }),
      );
      if (res.ok) return schema.parse(res.status === 204 ? null : await res.json());
      await res.body?.cancel();
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new AuthFailedError('Microsoft rejected the access token');
      if (res.status === 429 || res.status === 503) throw new ProviderThrottledError(retryAfterMs(res.headers.get('retry-after')), `Graph throttled the request (${res.status})`);
      throw new GraphHttpError(res.status, `Graph answered ${res.status} for ${method} ${url.pathname}`);
    }
  }

  /** Every item of a paged collection, following `@odata.nextLink`. */
  async function* list(ctx: AdapterContext, path: string, query?: Record<string, string>): AsyncGenerator<unknown> {
    const seen = new Set<string>();
    let page = await call(ctx, Page, path, query ? { query } : {});
    for (;;) {
      yield* page.value;
      const next = page['@odata.nextLink'];
      if (!next) return;
      if (seen.has(next)) throw new ProviderUnavailableError('Graph repeated a nextLink');
      seen.add(next);
      page = await call(ctx, Page, next);
    }
  }

  return { call, list, accessToken };
}
