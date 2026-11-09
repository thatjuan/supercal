/**
 * HTTP Basic for device and feed logins (architecture §7). Argon2 verification costs tens of milliseconds
 * and clients send Basic on every request, so successful verifications are cached for five
 * minutes, keyed by `sha256(username:password)`. Failures are throttled per username and per IP:
 * ten within five minutes block that key with 429 for five minutes. Both are per process.
 *
 * A cached login remembers the password hash it was verified against; the request handler
 * compares it with the credential row it loads anyway, so rotation or revocation takes effect
 * before a notification arrives. Owner membership is rechecked separately on every request.
 */
import type { DavLoginId, FeedId, TenantId } from '@supercal/db';

const CACHE_MS = 5 * 60_000;
const WINDOW_MS = 5 * 60_000;
const BLOCK_MS = 5 * 60_000;
const MAX_FAILURES = 10;
/** Bounds memory under a credential-stuffing flood; past it, stale entries are swept. */
const SWEEP_AT = 10_000;

/** What the username lookup returns: the columns `supercal_control` may read. */
export type DavLogin =
  | { kind: 'feed'; ownerUserId: string; id: FeedId; tenantId: TenantId; passwordHash: string }
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

/** Creates the per-process verifier. `lookup` finds a device or feed login by username (in `withControl`). */
export function createFeedAuth(lookup: (username: string) => Promise<DavLogin | null>, now = () => Date.now()) {
  const verified = new Map<string, { login: DavLogin; until: number }>();
  const failures = new Map<string, { at: number[]; blockedUntil: number }>();

  const blockedFor = (key: string) => Math.max(0, (failures.get(key)?.blockedUntil ?? 0) - now());

  function fail(key: string) {
    const t = now();
    const entry = failures.get(key) ?? { at: [], blockedUntil: 0 };
    entry.at = [...entry.at.filter((at) => t - at < WINDOW_MS), t];
    if (entry.at.length >= MAX_FAILURES) entry.blockedUntil = t + BLOCK_MS;
    failures.set(key, entry);
    if (failures.size > SWEEP_AT)
      for (const [k, e] of failures) if (e.blockedUntil < t && e.at.every((at) => t - at >= WINDOW_MS)) failures.delete(k);
  }

  return {
    /** Checks `Authorization` from `ip`. Blocked keys get 429 without a verification attempt. */
    async authenticate(header: string | undefined, ip: string): Promise<AuthResult> {
      const creds = parseBasic(header);
      if (!creds) return { ok: false, status: 401 };
      const keys = [`u:${creds.username}`, `ip:${ip}`];
      const blocked = Math.max(...keys.map(blockedFor));
      if (blocked > 0) return { ok: false, status: 429, retryAfter: Math.ceil(blocked / 1000) };

      const key = cacheKey(creds.username, creds.password);
      const hit = verified.get(key);
      if (hit && hit.until > now()) return { ok: true, login: hit.login };
      verified.delete(key);

      const login = await lookup(creds.username);
      if (!login?.passwordHash || !(await Bun.password.verify(creds.password, login.passwordHash).catch(() => false))) {
        keys.forEach(fail);
        return { ok: false, status: 401 };
      }
      if (verified.size > SWEEP_AT) for (const [k, v] of verified) if (v.until <= now()) verified.delete(k);
      verified.set(key, { login, until: now() + CACHE_MS });
      return { ok: true, login };
    },

    /** Drops cached verifications on feed rotation or device revocation. */
    forget(id: FeedId | DavLoginId) {
      for (const [k, v] of verified) if (v.login.id === id) verified.delete(k);
    },
  };
}

export type FeedAuth = ReturnType<typeof createFeedAuth>;
