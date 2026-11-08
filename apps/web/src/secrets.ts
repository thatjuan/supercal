/**
 * Feed secrets the server shows once (at feed creation or rotation), kept in memory for this page
 * load only, so the Subscribe screen can build links after a rotation in Settings. Never written
 * to localStorage, sessionStorage or the query cache: a reload forgets them, and the user rotates again.
 */
import { useSyncExternalStore } from 'react';

export type FeedSecrets = { icsToken?: string; caldavPassword?: string };

let secrets: ReadonlyMap<string, FeedSecrets> = new Map();
const listeners = new Set<() => void>();

/** Remembers newly issued secrets for `feedId`, merged over any already held. */
export function rememberFeedSecrets(feedId: string, next: FeedSecrets) {
  secrets = new Map(secrets).set(feedId, { ...secrets.get(feedId), ...next });
  listeners.forEach((notify) => notify());
}

/** Forgets every held secret (sign-out, tests). */
export function forgetFeedSecrets() {
  secrets = new Map();
  listeners.forEach((notify) => notify());
}

const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => listeners.delete(notify);
};

const NONE: FeedSecrets = {};

/** The secrets held for `feedId`; re-renders when they change. */
export const useFeedSecrets = (feedId: string): FeedSecrets => useSyncExternalStore(subscribe, () => secrets.get(feedId) ?? NONE);
