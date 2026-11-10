/**
 * What every sync job runs on (`SyncDeps`), and `withAccount`, which wraps each provider call for
 * an account: the per-account concurrency slot, the decrypted credentials, and the account status
 * that follows from the outcome (architecture §8):
 *
 * - `AuthFailedError` → `reauth_required`, every target of the account parked, its calendars stale.
 * - ten failures in a row on one target → `error` (targets keep retrying with backoff).
 * - a success → `active` again.
 *
 * Each transition emits `account.status` on the live stream.
 */
import {
  calendarAccount,
  NO_FRESHNESS,
  sink,
  sourceCalendar,
  syncTarget,
  withTenant,
  type CalendarAccount,
  type ConnectionStatus,
  type SecretBox,
  type SecretContext,
  type TenantId,
  type TenantTx,
} from '@supercal/db';
import { AuthFailedError, ProviderCredentials, type AdapterContext, type AdapterRegistry, type GuardedFetch, type ProviderAdapter } from '@supercal/providers';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import { membership } from '../auth/principal.ts';
import { notifyEvent } from '../bus.ts';
import type { FeedService } from '../feeds/service.ts';
import type { WriteBudget } from '../sinks/budget.ts';
import type { GoogleSinkClient } from '../sinks/google.ts';
import type { Logger } from '../log.ts';
import { StopTargetError, type Job } from './scheduler.ts';

export type SyncDeps = {
  adapters: AdapterRegistry;
  secrets: SecretBox;
  feeds: FeedService;
  fetch: GuardedFetch;
  log: Logger;
  /** The public https URL push notifications are sent to (`/hooks/<provider>` on it); null disables push. */
  pushBaseUrl: string | null;
  /** Runs `fn` in an account slot, refusing busy accounts with `AccountBusyError`. */
  accountSlot: <T>(accountId: string, fn: () => Promise<T>) => Promise<T>;
  /** Google sink calls; null when Google is not configured. */
  googleSinks: GoogleSinkClient | null;
  /** Sink writes per provider user (`createWriteBudget`). */
  sinkBudget: WriteBudget;
};

/** A job of a tenant's target (anything but maintenance). */
export type TenantJob = Job & { tenantId: TenantId };

/** Failures in a row on one target before its account shows `error`. */
const ERROR_STREAK = 10;

export class NoAdapterError extends Error {
  override readonly name = 'NoAdapterError';
}

/** The adapter for `provider`; a target of a provider without one cannot run. */
export function adapterFor(adapters: AdapterRegistry, provider: CalendarAccount['provider']): ProviderAdapter<unknown> {
  const adapter = provider === 'hosted' ? undefined : adapters[provider];
  if (!adapter) throw new NoAdapterError(`no adapter is registered for provider ${provider}`);
  return adapter;
}

export const credentialsContext = (account: Pick<CalendarAccount, 'id' | 'tenantId'>): SecretContext => ({
  tenantId: account.tenantId,
  table: 'calendar_account',
  recordId: account.id,
  field: 'credentials',
});

/**
 * Builds the adapter context for a stored account. `saveCredentials` (and lazy re-encryption under
 * a newer master key) compare-and-swap on the ciphertext read here, so two workers refreshing one
 * token cannot clobber each other: the later write is dropped and the stored credentials win.
 */
export async function accountContext(deps: SyncDeps, account: CalendarAccount, signal: AbortSignal): Promise<AdapterContext> {
  if (!account.credentials) throw new AuthFailedError('no credentials are stored for this account');
  const where = credentialsContext(account);
  const opened = await deps.secrets.decryptJson(ProviderCredentials, account.credentials, where);
  let stored = account.credentials;
  const swap = async (next: string) => {
    const rows = await withTenant(account.tenantId, (tx) =>
      tx
        .update(calendarAccount)
        .set({ credentials: next })
        .where(and(eq(calendarAccount.id, account.id), eq(calendarAccount.credentials, stored)))
        .returning({ id: calendarAccount.id }),
    );
    if (rows.length > 0) stored = next;
    else deps.log.info('credentials changed concurrently; keeping the stored ones', { accountId: account.id });
  };
  if (opened.reencrypted) await swap(opened.reencrypted);

  const ctx: AdapterContext = {
    fetch: deps.fetch,
    credentials: opened.value,
    signal,
    log: deps.log.child({ accountId: account.id, provider: account.provider }),
    async saveCredentials(next) {
      ctx.credentials = next;
      await swap(await deps.secrets.encryptJson(ProviderCredentials, next, where));
    },
  };
  return ctx;
}

/** Moves the account to `status` unless it is already there (or in one of `unless`), and emits `account.status`. */
async function transition(tx: TenantTx, account: CalendarAccount, status: ConnectionStatus, detail: string | null, unless: ConnectionStatus[] = []) {
  const [row] = await tx
    .update(calendarAccount)
    .set({ status, statusDetail: detail, updatedAt: new Date() })
    .where(and(eq(calendarAccount.id, account.id), notInArray(calendarAccount.status, [status, ...unless])))
    .returning({ id: calendarAccount.id });
  if (row) await notifyEvent(tx, account.tenantId, { type: 'account.status', accountId: account.id, status, ...(detail !== null && { detail }) });
}

/** The account's targets: its `discover` target, every calendar's targets and its sinks' targets. */
export const accountTargets = (account: Pick<CalendarAccount, 'id'>) =>
  or(
    eq(syncTarget.targetId, account.id),
    inArray(syncTarget.targetId, sql`(select ${sourceCalendar.id} from ${sourceCalendar} where ${sourceCalendar.accountId} = ${account.id})`),
    inArray(syncTarget.targetId, sql`(select ${sink.id} from ${sink} where ${sink.accountId} = ${account.id})`),
  );

/** `reauth_required`: parks the account's targets until reconnect, and marks its calendars stale. Published data stays. */
async function requireReauth(account: CalendarAccount, detail: string) {
  await withTenant(account.tenantId, async (tx) => {
    await transition(tx, account, 'reauth_required', detail, ['disabled']);
    await tx.update(syncTarget).set({ nextRunAt: sql`'infinity'::timestamptz` }).where(accountTargets(account));
    await tx
      .update(sourceCalendar)
      .set({ freshness: sql`${JSON.stringify(NO_FRESHNESS)}::jsonb || ${sourceCalendar.freshness} || '{"stale":true}'::jsonb` })
      .where(eq(sourceCalendar.accountId, account.id));
  });
}

/**
 * Runs `fn` with the account's adapter and context inside its concurrency slot, and applies the
 * account-status rules above to the outcome. An account needing reauth (or disabled) does not run.
 */
export async function withAccount<T>(
  deps: SyncDeps,
  job: TenantJob,
  account: CalendarAccount,
  signal: AbortSignal,
  fn: (adapter: ProviderAdapter<unknown>, ctx: AdapterContext) => Promise<T>,
): Promise<T> {
  if (account.status === 'reauth_required' || account.status === 'disabled') throw new StopTargetError(`account is ${account.status}`);
  if (account.provider !== 'hosted' && !await membership(account.ownerUserId, account.tenantId))
    throw new StopTargetError('the account owner is no longer a member');
  return deps.accountSlot(account.id, async () => {
    let result: T;
    try {
      signal.throwIfAborted();
      result = await fn(adapterFor(deps.adapters, account.provider), await accountContext(deps, account, signal));
    } catch (error) {
      if (error instanceof AuthFailedError) {
        await requireReauth(account, error.message);
        throw new StopTargetError(`authentication failed: ${error.message}`);
      }
      if (!signal.aborted && job.attempts >= ERROR_STREAK && error instanceof Error)
        await withTenant(account.tenantId, (tx) => transition(tx, account, 'error', error.message, ['reauth_required', 'disabled']));
      throw error;
    }
    if (account.status !== 'active') await withTenant(account.tenantId, (tx) => transition(tx, account, 'active', null, ['reauth_required', 'disabled']));
    return result;
  });
}
