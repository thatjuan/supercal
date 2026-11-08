/**
 * The query an OAuth callback returns with (`?connected=1&accountId=…` or `?error=<code>`): parsed
 * as a route's `validateSearch`, and turned into the toast the screen shows once.
 */
export type OAuthSearch = { connected?: true; accountId?: string; error?: string };

/** Keeps the known keys. The router parses `connected=1` as the number 1, so any value counts. */
export function oauthSearch(search: Record<string, unknown>): OAuthSearch {
  const { connected, accountId, error } = search;
  return {
    ...(connected !== undefined && { connected: true }),
    ...(typeof accountId === 'string' && { accountId }),
    ...(typeof error === 'string' && { error }),
  };
}

const ERRORS: Partial<Record<string, string>> = {
  access_denied: 'You declined access, so nothing was connected.',
  missing_scopes: 'Calendar access was not granted. Connect again and allow access to your calendars.',
  flow_expired: 'The sign-in took too long. Please try again.',
  session_mismatch: 'You were signed in to Supercal as someone else when the provider sent you back. Sign in again and retry.',
  no_refresh_token: 'The provider did not grant offline access. Remove Supercal from your account’s connected apps, then connect again.',
};

/** The notice for an OAuth return, or null when the address carries none. */
export function oauthToast(search: OAuthSearch): { tone: 'success' | 'error'; message: string } | null {
  if (search.error) return { tone: 'error', message: ERRORS[search.error] ?? `Connecting failed (${search.error}). Please try again.` };
  if (search.connected && search.accountId) return { tone: 'success', message: 'Account connected. Its calendars are syncing now.' };
  return null;
}
