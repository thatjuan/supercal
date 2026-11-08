/**
 * The provider adapter contract (architecture §8). An adapter only talks to its provider: it lists
 * calendars and yields raw pages, and the daemon's sync runner owns every database write, the
 * normalisation and the cursor. Adapters register themselves in `registry`.
 *
 *   for await (const item of adapter.sync(ctx, calendar, cursor)) …   // page, page, …, end
 */
import type { AccountProvider, CalendarCapabilities, PushTarget, SourceFormat } from '@supercal/db';
import type { GuardedFetch } from './transport/index.ts';
import type { ProviderCredentials } from './credentials.ts';

export type Provider = AccountProvider;
export type ProviderObjectId = string;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** One provider object. `payload: null` is a touch: the object exists unchanged, so only its snapshot generation is refreshed. */
export type RawObject = {
  id: ProviderObjectId;
  etag: string;
  /** The iCalendar UID this object contributes to; objects sharing it normalise together. */
  groupUid: string;
  /** Recurrence identity of an exception, as the provider wrote it. */
  originalStart?: string;
  /** iCalendar text (`ical`) or provider JSON (`google`, `graph`). */
  payload: string | JsonValue | null;
};

export type SyncPage = { kind: 'page'; upserts: RawObject[]; deletes: ProviderObjectId[] };

/**
 * The last item of a sync. `snapshot`: every existing object was yielded, so the runner deletes the
 * rest. `nextPollHint` (e.g. from Cache-Control) replaces the default cadence, within the policy bounds.
 */
export type SyncEnd<Cursor> = { kind: 'end'; mode: 'delta' | 'snapshot'; cursor: Cursor; nextPollHint?: { afterMs: number } };

export type SourceCalendarInfo = {
  providerCalendarId: string;
  name: string;
  color: string | null;
  /** IANA zone, when the provider names one. */
  timezone: string | null;
  capabilities: CalendarCapabilities;
};

/** The calendar a sync runs for. */
export type SourceCalendarRef = { id: string; providerCalendarId: string; capabilities: CalendarCapabilities };

export type PushLeaseInfo = {
  target: PushTarget;
  targetId: string;
  providerChannelId: string;
  providerResourceId: string | null;
  expiresAt: Date;
  providerState: JsonValue | null;
};

/** Structured logger; the daemon's logger satisfies it. */
export type Logger = Record<'debug' | 'info' | 'warn' | 'error', (msg: string, fields?: Record<string, unknown>) => void>;

export type AdapterContext = {
  /** The guarded transport; adapters for fixed provider hosts (Google, Graph) may use their own client. */
  fetch: GuardedFetch;
  credentials: ProviderCredentials;
  /** Persists changed credentials (e.g. refreshed OAuth tokens), encrypted and compare-and-swapped. */
  saveCredentials(next: ProviderCredentials): Promise<void>;
  log: Logger;
  /** Aborted when the lease is lost or the process stops. */
  signal: AbortSignal;
};

export interface ProviderAdapter<Cursor> {
  readonly provider: Provider;
  readonly format: SourceFormat;
  readonly capabilities: { calendarDiscovery: 'poll' | 'push' | 'single'; push: 'none' | 'calendar' | 'account' };
  listCalendars(ctx: AdapterContext): Promise<SourceCalendarInfo[]>;
  /**
   * Yields raw pages, then exactly one `end`. Only `end` carries the cursor (Google returns its sync
   * token on the last page). `cursor` is whatever the adapter last returned, or null; adapters
   * validate it (it is versioned JSON) and start a snapshot when it is unusable.
   */
  sync(ctx: AdapterContext, calendar: SourceCalendarRef, cursor: Cursor | null): AsyncIterable<SyncPage | SyncEnd<Cursor>>;
  push?: {
    subscribe(ctx: AdapterContext, target: { target: PushTarget; targetId: string }): Promise<PushLeaseInfo>;
    renew(ctx: AdapterContext, lease: PushLeaseInfo): Promise<PushLeaseInfo>;
    teardown(ctx: AdapterContext, lease: PushLeaseInfo): Promise<void>;
  };
}

/** The credentials were rejected; the account moves to `reauth_required`. */
export class AuthFailedError extends Error {
  override readonly name = 'AuthFailedError';
}

/** The provider asked us to slow down; the target retries no sooner than `retryAfterMs`. */
export class ProviderThrottledError extends Error {
  override readonly name = 'ProviderThrottledError';
  constructor(
    readonly retryAfterMs: number,
    message = 'provider throttled the request',
  ) {
    super(message);
  }
}

/** A transient provider failure; the target retries with backoff. */
export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
}

export type AdapterRegistry = { readonly [P in Provider]?: ProviderAdapter<unknown> };

/** Every adapter, by provider. The provider issues register theirs here. */
export const registry: AdapterRegistry = {};
