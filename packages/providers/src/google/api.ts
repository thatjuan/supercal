/**
 * Calls to the Google Calendar API v3 for one account: a per-account token bucket (5 req/s; the
 * documented quota is 600/min/user), access-token refresh within 60 s of expiry (saved through
 * `ctx.saveCredentials`, which compare-and-swaps), and Google's errors mapped onto the adapter
 * contract. Google is a fixed host, so these use plain `fetch`, not the guarded transport.
 */
import { z } from 'zod';
import { AuthFailedError, ProviderConflictError, ProviderWriteRejectedError, ProviderThrottledError, ProviderUnavailableError, type AdapterContext } from '../adapter.ts';
import type { GoogleCredentials } from '../credentials.ts';
import { OAuthError, tokenRequest } from '../oauth.ts';

export const GOOGLE_EVENTS_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** Whether the account granted a Google scope, including granular consent. */
export const hasScope = (ctx: AdapterContext, scope: string): boolean => ctx.credentials.provider === 'google' && ctx.credentials.scopes.includes(scope);

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Shown as the account's `status_detail` when Google refuses the refresh token. */
export const GOOGLE_INVALID_GRANT_DETAIL =
  'Google rejected the refresh token (invalid_grant), so the account needs to be reconnected. If this keeps happening about every 7 days, the Google OAuth app is in Testing publishing status, where refresh tokens expire after 7 days: publish it to Production.';

const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const PERMISSION_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);

export type GoogleClientOptions = {
  clientId: string;
  clientSecret: string;
  /** Overridden in tests to point at a local mock. */
  apiBase?: string;
  tokenUrl?: string;
  /** Requests per second per account. */
  ratePerSecond?: number;
};

/** A non-2xx answer the caller may handle by status (410 GONE on a sync token, 404 on a stopped channel). */
export class GoogleHttpError extends ProviderUnavailableError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** Milliseconds from a Retry-After header (seconds or an HTTP date). */
function retryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, at - Date.now());
}

const ErrorBody = z.object({ error: z.object({ status: z.string().optional(), errors: z.array(z.object({ reason: z.string().optional() })).optional() }) });

/** The first `reason` (or the `status`) of a Google error body, if any. */
async function errorReason(res: Response): Promise<string | undefined> {
  const body = ErrorBody.safeParse(await res.json().catch(() => null));
  return body.success ? (body.data.error.errors?.[0]?.reason ?? body.data.error.status) : undefined;
}

function googleCredentials(ctx: AdapterContext): GoogleCredentials {
  if (ctx.credentials.provider !== 'google') throw new AuthFailedError(`expected Google credentials, got ${ctx.credentials.provider}`);
  return ctx.credentials;
}

export type GoogleApi = ReturnType<typeof createGoogleApi>;

export function createGoogleApi({ clientId, clientSecret, apiBase = GOOGLE_API, tokenUrl = GOOGLE_TOKEN_URL, ratePerSecond = 5 }: GoogleClientOptions) {
  const buckets = new Map<string, { tokens: number; at: number }>();

  /** Waits for a request slot of the account `key`. */
  async function take(key: string, signal: AbortSignal) {
    for (;;) {
      const now = Date.now();
      const bucket = buckets.get(key) ?? { tokens: ratePerSecond, at: now };
      bucket.tokens = Math.min(ratePerSecond, bucket.tokens + ((now - bucket.at) / 1000) * ratePerSecond);
      bucket.at = now;
      buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens--;
        return;
      }
      await sleep(((1 - bucket.tokens) / ratePerSecond) * 1000, signal);
    }
  }

  /** A usable access token, refreshed (and saved) when it expires within a minute or `force` is set. */
  async function accessToken(ctx: AdapterContext, force = false): Promise<string> {
    const credentials = googleCredentials(ctx);
    if (!force && Date.parse(credentials.accessTokenExpiresAt) - Date.now() > REFRESH_MARGIN_MS) return credentials.accessToken;
    let token;
    try {
      token = await tokenRequest(tokenUrl, { grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: clientId, client_secret: clientSecret }, ctx.signal);
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'invalid_grant') throw new AuthFailedError(GOOGLE_INVALID_GRANT_DETAIL);
      if (error instanceof OAuthError) throw new ProviderUnavailableError(`Google token refresh failed: ${error.message}`);
      throw error;
    }
    await ctx.saveCredentials({
      ...credentials,
      accessToken: token.access_token,
      accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      refreshToken: token.refresh_token ?? credentials.refreshToken,
      scopes: token.scope ? token.scope.split(' ') : credentials.scopes,
    });
    return token.access_token;
  }

  /**
   * Calls `path` (relative to the API base) and parses the JSON answer with `schema`. A 401 refreshes
   * the token and retries once; throttling becomes `ProviderThrottledError`. Write callers use
   * `forbidden: 'reject'` for object refusals and `headers` for If-Match: only refresh authentication
   * failures can park their account. Read callers retain the missing-scope authentication error.
   */
  async function call<S extends z.ZodType>(
    ctx: AdapterContext,
    schema: S,
    path: string,
    { method = 'GET', query, body, headers, forbidden = 'auth' }: { method?: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; forbidden?: 'auth' | 'reject' } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(apiBase + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const key = googleCredentials(ctx).sub;
    for (let attempt = 0; ; attempt++) {
      await take(key, ctx.signal);
      const token = await accessToken(ctx, attempt > 0);
      const res = await fetch(url, {
        method,
        headers: { ...headers, authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: ctx.signal,
      });
      if (res.ok) return schema.parse(res.status === 204 ? null : await res.json());
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw forbidden === 'reject' ? new ProviderWriteRejectedError('read-only', 'Google rejected the access token') : new AuthFailedError('Google rejected the access token');
      if (res.status === 429) throw new ProviderThrottledError(retryAfterMs(res.headers.get('retry-after')), 'Google throttled the request');
      if (res.status === 412) throw new ProviderConflictError('Google event ETag does not match');
      if (forbidden === 'reject') {
        if (res.status === 404 || res.status === 410) throw new ProviderWriteRejectedError('not-found', 'Google event no longer exists');
        if (res.status === 400) {
          const body = z.object({ error: z.object({ message: z.string() }) }).safeParse(await res.json().catch(() => null));
          throw new ProviderWriteRejectedError('invalid-data', body.success ? body.data.error.message : 'Google rejected the event data');
        }
      }
      if (res.status === 403) {
        const reason = await errorReason(res);
        if (reason && RATE_LIMIT_REASONS.has(reason)) throw new ProviderThrottledError(retryAfterMs(res.headers.get('retry-after')), `Google throttled the request (${reason})`);
        if (forbidden === 'reject') throw new ProviderWriteRejectedError('read-only', 'Google refused this event write');
        if (reason && PERMISSION_REASONS.has(reason)) throw new AuthFailedError('Supercal lacks the Google Calendar permissions it needs; reconnect and grant them');
      }
      throw new GoogleHttpError(res.status, `Google answered ${res.status} for ${method} ${url.pathname}`);
    }
  }

  return { call, accessToken };
}
