/**
 * Sink data for the Subscribe page's "Live updates in Google Calendar" card. Creating a sink may
 * need incremental consent: the API answers 409 with an `authorizationUrl`, Google sends the
 * browser back to the Subscribe page with `sinkPublication`/`sinkAccount` (what to create) and
 * `accountId` or `error`, and the card then creates the sink, or says why it did not.
 */
import type { components } from '@supercal/api-client';
import { $api } from '../../api.ts';

export type Sink = components['schemas']['Sink'];

export const sinksQuery = $api.queryOptions('get', '/api/v1/sinks');

/** The Subscribe page's search params for a consent round trip. */
export type SinkSearch = { sinkPublication?: string; sinkAccount?: string; accountId?: string; error?: string };

/** Keeps the known keys, as the route's `validateSearch`. */
export function sinkSearch(search: Record<string, unknown>): SinkSearch {
  const pick = (key: keyof SinkSearch) => (typeof search[key] === 'string' ? { [key]: search[key] } : {});
  return { ...pick('sinkPublication'), ...pick('sinkAccount'), ...pick('accountId'), ...pick('error') };
}

/** Where consent sends the browser back: this page, remembering which sink to create. */
export const consentReturnTo = (feedId: string, publicationId: string, accountId: string) =>
  `/feeds/${feedId}/subscribe?${new URLSearchParams({ sinkPublication: publicationId, sinkAccount: accountId })}`;

const ERRORS: Partial<Record<string, string>> = {
  consent_declined: 'Google did not grant permission to create a calendar, so nothing was mirrored. The account still syncs as before.',
  access_denied: 'You cancelled at Google, so nothing was mirrored. The account still syncs as before.',
  account_mismatch: 'You chose a different Google account at Google than the one you picked here. Try again with the same account.',
};

/** What a consent return asks for: create the sink, or show why consent failed; null when the address carries none. */
export function consentReturn(search: SinkSearch): { create: { publicationId: string; accountId: string } } | { error: string } | null {
  if (!search.sinkPublication || !search.sinkAccount) return null;
  if (search.error) return { error: ERRORS[search.error] ?? `Google consent failed (${search.error}). Please try again.` };
  if (search.accountId !== search.sinkAccount) return null;
  return { create: { publicationId: search.sinkPublication, accountId: search.sinkAccount } };
}

/** The consent URL of a 409 `needs-consent` problem, or null for any other error. */
export function consentUrl(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'authorizationUrl' in error && typeof error.authorizationUrl === 'string' ? error.authorizationUrl : null;
}
