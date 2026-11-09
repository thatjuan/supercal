/**
 * HTTP Basic for device and feed logins (architecture §7). Argon2 verification costs tens of milliseconds
 * and clients send Basic on every request, so successful verifications are cached for five
 * minutes, keyed by `sha256(username:password)`, and accepted before checking failure budgets.
 * Failures and in-flight attempts share a ten-attempt budget per source and username; ten failures
 * within five minutes block that pair for five minutes. Argon2 runs at most four verifications
 * at once with up to 64 queued; overflow gets 429. All limits and caches are per process.
 *
 * A cached login remembers the password hash it was verified against; the request handler
 * compares it with the credential row it loads anyway, so rotation or revocation takes effect
 * before a notification arrives. Device membership is rechecked separately on every request.
 */
import type { DavLoginId, FeedId, TenantId } from '@supercal/db';

const CACHE_MS = 5 * 60_000;
const WINDOW_MS = 5 * 60_000;
const BLOCK_MS = 5 * 60_000;
const MAX_FAILURES = 10;
const MAX_VERIFYING = 4;
const MAX_VERIFY_WAITERS = 64;
/** Bounds memory under a credential-stuffing flood; past it, stale entries are swept. */
const SWEEP_AT = 10_000;

/** What the username lookup returns: the columns `supercal_control` may read. */
export type DavLogin =
  | { kind: 'feed'; id: FeedId; tenantId: TenantId; passwordHash: string }
  | { kind: 'user'; id: DavLoginId; userId: string; tenantId: TenantId; passwordHash: string };

export type AuthResult =
  | { ok: true; login: DavLogin }
  | { ok: false; status: 401 | 429; retryAfter?: number };

/** Username and password from a `Basic` Authorization header. */
export function parseBasic(header: string | undefined): { username: string; password: string } | null {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const cacheKey = (username: string, password: string) => new Bun.CryptoHasher('sha256').update(`${username}:${password}`).digest('hex');

type Lookup = (username: string) => Promise<DavLogin | null>;

/** Creates the per-process verifier. `lookup` finds a device or feed login by username (in `withControl`). */
export function createFeedAuth(lookup: Lookup, { now = Date.now, verify = Bun.password.verify }: { now?: () => number; verify?: typeof Bun.password.verify } = {}) {
  const verified = new Map<string, { login: DavLogin; until: number }>();
  const failures = new Map<string, { at: number[]; blockedUntil: number; inFlight: number }>();
  let verifying = 0;
  const waiters: (() => void)[] = [];

  /** Transfers the verification slot directly to the next waiter, or returns it to the pool. */
  function releaseVerification() {
    const next = waiters.shift();
    if (next) next();
    else verifying--;
  }

  return {
    /** Checks `Authorization` from `ip`, reserving failure budget before any asynchronous work. */
    async authenticate(header: string | undefined, ip: string | null): Promise<AuthResult> {
      const creds = parseBasic(header);
      if (!creds) return { ok: false, status: 401 };
      const key = cacheKey(creds.username, creds.password);
      const hit = verified.get(key);
      if (hit && hit.until > now()) return { ok: true, login: hit.login };
      verified.delete(key);

      const t = now();
      const failureKey = `${ip ?? 'unknown'}\0${creds.username}`;
      const entry = failures.get(failureKey) ?? { at: [], blockedUntil: 0, inFlight: 0 };
      entry.at = entry.at.filter((at) => t - at < WINDOW_MS);
      if (entry.blockedUntil > t || entry.at.length + entry.inFlight >= MAX_FAILURES) {
        return { ok: false, status: 429, retryAfter: Math.ceil((entry.blockedUntil > t ? entry.blockedUntil - t : BLOCK_MS) / 1000) };
      }
      entry.inFlight++;
      failures.set(failureKey, entry);
      if (failures.size > SWEEP_AT)
        for (const [k, e] of failures) if (e.inFlight === 0 && e.blockedUntil <= t && e.at.every((at) => t - at >= WINDOW_MS)) failures.delete(k);

      try {
        const login = await lookup(creds.username);
        let valid = false;
        if (login?.passwordHash) {
          if (verifying < MAX_VERIFYING) verifying++;
          else {
            if (waiters.length >= MAX_VERIFY_WAITERS) return { ok: false, status: 429, retryAfter: 5 };
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          try {
            valid = await verify(creds.password, login.passwordHash).catch(() => false);
          } finally {
            releaseVerification();
          }
        }
        if (!login || !valid) {
          const failedAt = now();
          entry.at = [...entry.at.filter((at) => failedAt - at < WINDOW_MS), failedAt];
          if (entry.at.length >= MAX_FAILURES) entry.blockedUntil = failedAt + BLOCK_MS;
          return { ok: false, status: 401 };
        }
        if (verified.size > SWEEP_AT) for (const [k, v] of verified) if (v.until <= now()) verified.delete(k);
        verified.set(key, { login, until: now() + CACHE_MS });
        return { ok: true, login };
      } finally {
        entry.inFlight--;
      }
    },

    /** Drops cached verifications on feed rotation or device revocation. */
    forget(id: FeedId | DavLoginId) {
      for (const [k, v] of verified) if (v.login.id === id) verified.delete(k);
    },
  };
}

export type FeedAuth = ReturnType<typeof createFeedAuth>;
