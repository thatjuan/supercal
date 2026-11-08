/**
 * Provider-independent account flows behind `/api/v1/accounts` (architecture §12). Each takes the
 * acting principal and enforces `canManageOwned` on the account's owner (404 when the id is not
 * visible in the tenant). Provider-specific input (an API variant or an OAuth callback) is turned
 * into a `NewAccount` by the caller; `connectAccount` is the shared flow from there, and
 * `reconnectAccount` replaces the credentials of an account that is already connected.
 */
import {
  calendarAccount,
  newId,
  pushLease,
  sourceCalendar,
  syncTarget,
  withTenant,
  type AccountId,
  type CalendarAccount,
  type PushLease,
  type SourceCalendar,
  type TenantTx,
} from '@supercal/db';
import { ProviderCredentials, type JsonValue } from '@supercal/providers';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { audit } from '../api/kit/audit.ts';
import { notifyEvent } from '../bus.ts';
import { Forbidden, NotFound, TooManyRequests } from '../api/kit/problem.ts';
import { canManageOwned } from '../auth/policy.ts';
import type { Principal } from '../auth/principal.ts';
import { accountContext, accountTargets, adapterFor, credentialsContext, type SyncDeps } from './context.ts';
import { applyListing, ensureTarget } from './discovery.ts';
import { wakeTargets } from './scheduler.ts';

/** A manual sync of one account at most this often. */
const SYNC_REQUEST_INTERVAL_MS = 30_000;
/** How long `POST /accounts` may spend listing calendars. */
const CONNECT_TIMEOUT_MS = 30_000;

export type NewAccount = {
  credentials: ProviderCredentials;
  displayName: string;
  email?: string | null;
  serverUrl?: string | null;
  providerSubject?: string | null;
};

/** The account, if visible in the tenant and manageable by `principal`. */
export async function loadAccount(tx: TenantTx, principal: Principal, id: AccountId): Promise<CalendarAccount> {
  const [row] = await tx.select().from(calendarAccount).where(eq(calendarAccount.id, id));
  if (!row) throw new NotFound('No such account');
  if (!canManageOwned(principal, row.ownerUserId)) throw new Forbidden('You can only manage your own accounts');
  return row;
}

/**
 * Connects an account for the principal: lists its calendars first (which proves the credentials;
 * `AuthFailedError` propagates), then stores the account, its calendars, their publications and
 * targets in one transaction. Discovery runs again at once.
 */
export async function connectAccount(deps: SyncDeps, principal: Principal, input: NewAccount): Promise<{ account: CalendarAccount; calendars: SourceCalendar[] }> {
  const { provider } = input.credentials;
  const adapter = adapterFor(deps.adapters, provider);
  let credentials = input.credentials;
  const infos = await adapter.listCalendars({
    fetch: deps.fetch,
    credentials,
    saveCredentials: async (next) => void (credentials = next),
    log: deps.log.child({ provider }),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  const id = newId('acc');
  const tenantId = principal.tenantId;
  return withTenant(tenantId, async (tx) => {
    const [account] = await tx
      .insert(calendarAccount)
      .values({
        id,
        tenantId,
        ownerUserId: principal.userId,
        provider,
        displayName: input.displayName,
        email: input.email ?? null,
        serverUrl: input.serverUrl ?? null,
        providerSubject: input.providerSubject ?? null,
        credentials: await deps.secrets.encryptJson(ProviderCredentials, credentials, credentialsContext({ id, tenantId })),
      })
      .returning();
    if (!account) throw new Error('account insert returned no row');
    const calendars = await applyListing(tx, deps.feeds, account, infos, { sweep: false });
    await wakeTargets(tx, [await ensureTarget(tx, account, 'discover', account.id)]);
    // The calendar-list watch, which wakes discovery when calendars are added or removed.
    if (adapter.capabilities.calendarDiscovery === 'push') await wakeTargets(tx, [await ensureTarget(tx, account, 'push_renew', account.id)]);
    await audit(tx, principal, 'account.create', { type: 'account', id }, { provider, displayName: input.displayName, calendars: calendars.length });
    return { account, calendars };
  });
}

/** Renames the account or toggles auto-publishing of newly discovered calendars. `check` sees the current row first (If-Match). */
export async function updateAccount(
  principal: Principal,
  id: AccountId,
  changes: { displayName?: string | undefined; autoPublish?: boolean | undefined },
  check: (current: CalendarAccount) => void,
): Promise<CalendarAccount> {
  return withTenant(principal.tenantId, async (tx) => {
    check(await loadAccount(tx, principal, id));
    const [row] = await tx
      .update(calendarAccount)
      .set({ ...(changes.displayName !== undefined && { displayName: changes.displayName }), ...(changes.autoPublish !== undefined && { autoPublish: changes.autoPublish }), updatedAt: new Date() })
      .where(eq(calendarAccount.id, id))
      .returning();
    if (!row) throw new NotFound('No such account');
    await audit(tx, principal, 'account.update', { type: 'account', id }, changes);
    return row;
  });
}

/** Stops the account's push subscriptions with its current credentials, best effort: a lease that cannot be stopped expires. */
async function teardownLeases(deps: SyncDeps, account: CalendarAccount, leases: PushLease[]): Promise<void> {
  const push = deps.adapters[account.provider]?.push;
  if (!push || leases.length === 0) return;
  try {
    const ctx = await accountContext(deps, account, AbortSignal.timeout(CONNECT_TIMEOUT_MS));
    // `provider_state` is whatever the adapter returned when it subscribed.
    for (const lease of leases) await push.teardown(ctx, { ...lease, providerState: lease.providerState as JsonValue | null });
  } catch (error) {
    deps.log.warn('push teardown failed; leases will expire', { accountId: account.id, error });
  }
}

/**
 * Disconnects an account: tears down its push subscriptions (best effort), disables the
 * publications its calendars fed (bumping their epochs), and deletes its targets, calendars and
 * their resources.
 */
export async function deleteAccount(deps: SyncDeps, principal: Principal, id: AccountId): Promise<void> {
  const { account, leases } = await withTenant(principal.tenantId, async (tx) => ({
    account: await loadAccount(tx, principal, id),
    leases: await tx.select().from(pushLease).where(eq(pushLease.accountId, id)),
  }));
  await teardownLeases(deps, account, leases);

  await withTenant(principal.tenantId, async (tx) => {
    await loadAccount(tx, principal, id);
    const calendars = await tx.select({ id: sourceCalendar.id }).from(sourceCalendar).where(eq(sourceCalendar.accountId, id));
    for (const calendar of calendars) await deps.feeds.onCalendarGone(tx, calendar.id);
    await tx.delete(syncTarget).where(accountTargets(account));
    await tx.delete(calendarAccount).where(eq(calendarAccount.id, id));
    await audit(tx, principal, 'account.delete', { type: 'account', id }, { provider: account.provider, displayName: account.displayName });
  });
}

/** The principal's own account of `provider` with this provider identity, if connected in the tenant. */
export async function findOwnAccount(principal: Principal, provider: CalendarAccount['provider'], providerSubject: string): Promise<CalendarAccount | null> {
  const [row] = await withTenant(principal.tenantId, (tx) =>
    tx
      .select()
      .from(calendarAccount)
      .where(and(eq(calendarAccount.provider, provider), eq(calendarAccount.providerSubject, providerSubject), eq(calendarAccount.ownerUserId, principal.userId))),
  );
  return row ?? null;
}

/**
 * Reconnects an account with new credentials (OAuth reconnect): stores them, makes the account
 * `active`, stops its old push subscriptions and wakes every target, so parked targets run again
 * and push is set up afresh.
 */
export async function reconnectAccount(deps: SyncDeps, principal: Principal, id: AccountId, credentials: ProviderCredentials, { email }: { email: string | null }): Promise<CalendarAccount> {
  const { account, leases } = await withTenant(principal.tenantId, async (tx) => {
    const current = await loadAccount(tx, principal, id);
    const [row] = await tx
      .update(calendarAccount)
      .set({
        credentials: await deps.secrets.encryptJson(ProviderCredentials, credentials, credentialsContext(current)),
        status: 'active',
        statusDetail: null,
        email,
        updatedAt: new Date(),
      })
      .where(eq(calendarAccount.id, id))
      .returning();
    if (!row) throw new NotFound('No such account');
    await notifyEvent(tx, row.tenantId, { type: 'account.status', accountId: id, status: 'active' });
    await audit(tx, principal, 'account.reconnect', { type: 'account', id }, { provider: row.provider });
    return { account: row, leases: await tx.select().from(pushLease).where(eq(pushLease.accountId, id)) };
  });
  await teardownLeases(deps, account, leases);
  await withTenant(principal.tenantId, async (tx) => {
    await tx.delete(pushLease).where(inArray(pushLease.providerChannelId, leases.map((l) => l.providerChannelId)));
    const targets = await tx.select({ id: syncTarget.id }).from(syncTarget).where(accountTargets(account));
    await wakeTargets(tx, targets.map((t) => t.id));
  });
  return account;
}

/** Makes every target of the account due now and wakes the workers. 429 within 30 s of the previous request. */
export async function requestSync(principal: Principal, id: AccountId): Promise<void> {
  await withTenant(principal.tenantId, async (tx) => {
    const account = await loadAccount(tx, principal, id);
    const [accepted] = await tx
      .update(calendarAccount)
      .set({ syncRequestedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(calendarAccount.id, id),
          or(isNull(calendarAccount.syncRequestedAt), lt(calendarAccount.syncRequestedAt, sql`clock_timestamp() - ${SYNC_REQUEST_INTERVAL_MS} * interval '1 millisecond'`)),
        ),
      )
      .returning({ id: calendarAccount.id });
    if (!accepted) throw new TooManyRequests('This account was synced moments ago; try again in 30 seconds');
    const targets = await tx.select({ id: syncTarget.id }).from(syncTarget).where(accountTargets(account));
    await wakeTargets(tx, targets.map((t) => t.id));
    await audit(tx, principal, 'account.sync', { type: 'account', id });
  });
}
