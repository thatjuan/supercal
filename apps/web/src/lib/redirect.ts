/** Search params for screens that return somewhere after signing in. */
export type RedirectSearch = { redirect?: string };

/**
 * Keeps `redirect` only when it is a same-origin path, so a crafted sign-in link cannot send the
 * user elsewhere. Used as `validateSearch` on the auth routes.
 */
export function redirectSearch(search: Record<string, unknown>): RedirectSearch {
  const { redirect } = search;
  return typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') ? { redirect } : {};
}
