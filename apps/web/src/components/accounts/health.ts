/**
 * What the account screens say about an account's health, derived from the account and its
 * calendars (architecture §8: freshness is observed, never promised).
 */
import type { components } from '@supercal/api-client';

export type Account = components['schemas']['Account'];
export type Calendar = Extract<components['schemas']['Calendar'], { kind: 'connected' }>;
export type Provider = Account['provider'];

/** The badge states: the stored status, plus `syncing`, which the UI derives (see `accountHealth`). */
export type AccountHealth = Account['status'] | 'syncing';

/** How long a requested sync shows as `syncing` without news, matching the API's 30 s sync limit. */
export const SYNC_COOLDOWN_MS = 30_000;

const lastSuccess = (calendars: readonly Calendar[]): number | null => {
  const times = calendars.flatMap((calendar) => (calendar.freshness.lastSuccessAt ? [Date.parse(calendar.freshness.lastSuccessAt)] : []));
  return times.length > 0 ? Math.max(...times) : null;
};

/**
 * The account's badge. A non-active status wins. An active account is `syncing` while one of its
 * calendars has never synced (discovery just ran), or for up to `SYNC_COOLDOWN_MS` after a manual
 * sync (`syncRequestedAt`) until a calendar reports a success after it.
 */
export function accountHealth(account: Account, calendars: readonly Calendar[], syncRequestedAt?: number, now = Date.now()): AccountHealth {
  if (account.status !== 'active') return account.status;
  const live = calendars.filter((calendar) => calendar.state === 'active');
  if (live.some((calendar) => calendar.freshness.lastSuccessAt === null)) return 'syncing';
  if (syncRequestedAt !== undefined && now - syncRequestedAt < SYNC_COOLDOWN_MS && (lastSuccess(live) ?? 0) < syncRequestedAt) return 'syncing';
  return 'active';
}

/** An account's sync summary: last success over its calendars, push or the shortest poll interval, and how many calendars. */
export function accountFreshness(calendars: readonly Calendar[]) {
  const live = calendars.filter((calendar) => calendar.state === 'active');
  const latencies = live.flatMap((calendar) => (calendar.freshness.expectedLatency === null ? [] : [calendar.freshness.expectedLatency]));
  return {
    lastSuccessAt: lastSuccess(live),
    pushActive: live.length > 0 && live.every((calendar) => calendar.freshness.pushActive),
    pollMinutes: latencies.length > 0 ? Math.max(1, Math.round(Math.min(...latencies) / 60)) : null,
    calendarCount: live.length,
  };
}

const UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['min', 60_000],
] as const;

/** `time` relative to `now` in short words, as the design writes it: "just now", "2 min ago", "3 h ago", "4 d ago". */
export function timeAgo(time: number, now = Date.now()): string {
  const elapsed = now - time;
  for (const [unit, size] of UNITS) if (elapsed >= size) return `${Math.floor(elapsed / size)} ${unit} ago`;
  return 'just now';
}

/** Plain words for an account that needs attention, or null when it needs none. */
export function statusMessage(account: Pick<Account, 'provider' | 'status' | 'statusDetail'>): string | null {
  const detail = account.statusDetail?.trim();
  if (account.status === 'reauth_required') {
    if (account.provider === 'google' && detail && /testing/i.test(detail) && /7[ -]days?/i.test(detail)) {
      return 'Google signed this account out because this server’s Google app is in Testing mode, where sign-ins expire after 7 days. Reconnect to resume syncing, and ask the operator to publish the app so it stops happening.';
    }
    const why = detail ? ` The provider said: “${detail}”` : '';
    return `The provider no longer accepts Supercal’s sign-in, so syncing is paused. Reconnect to resume; the calendars keep publishing their last good data meanwhile.${why}`;
  }
  if (account.status === 'error') return `Syncing failed${detail ? `: ${detail}` : ''}. Supercal retries on its own; Sync now tries again at once.`;
  if (account.status === 'disabled') return 'This account is disabled and does not sync.';
  return null;
}
