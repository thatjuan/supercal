/** Synchronous provider writes: check in a short transaction, call upstream, then apply its result. */
import { normalizers, validateObject } from '@supercal/core';
import { calendarAccount, davObjectName, graphOccurrence, recordChanges, sourceObject, syncTarget, withTenant, type SourceCalendarId } from '@supercal/db';
import { AuthFailedError, ProviderConflictError, ProviderPartialWriteError, ProviderThrottledError, ProviderUnavailableError, ProviderWriteRejectedError, type StoredObject, type WriteResult } from '@supercal/providers';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, ProblemError } from '../api/kit/index.ts';
import type { Principal } from '../auth/principal.ts';
import { importedPublication, pubIndex } from '../dav/store.ts';
import { requireAccess } from '../hosted/access.ts';
import { HostedWriteError, lockCalendarWrites } from '../hosted/objects.ts';
import { normalizeDirtyGroups } from '../sync/changes.ts';
import { accountContext, requireReauth, type SyncDeps } from '../sync/context.ts';
import { applyRawObjects } from '../sync/objects.ts';

/** Provider-independent dependencies; writes deliberately do not acquire an account sync slot. */
export type WriteDeps = Pick<SyncDeps, 'adapters' | 'secrets' | 'fetch' | 'log'>;

/** Conditional device request fields shared by PUT and DELETE. */
type Preconditions = { objectName: string; ifMatch?: string; ifNoneMatch?: '*' };

/** Resolve client names and check the device ETag before making any provider request. */
async function check(deps: WriteDeps, principal: Principal, calendarId: SourceCalendarId, input: Preconditions, bodyUid?: string) {
  return withTenant(principal.tenantId, async (tx) => {
    const { calendar } = await requireAccess(tx, principal, calendarId, 'write').catch((error: unknown) => {
      if (error instanceof ProblemError) throw new HostedWriteError('read-only', 'Calendar is not writable');
      throw error;
    });
    const [account] = await tx.select().from(calendarAccount).where(eq(calendarAccount.id, calendar.accountId));
    const adapter = account && account.provider !== 'hosted' && account.provider !== 'ics' ? deps.adapters[account.provider] : undefined;
    if (!account || calendar.state !== 'active' || calendar.capabilities.write !== true || !adapter?.writes
      || account.status === 'reauth_required' || account.status === 'disabled') throw new HostedWriteError('read-only', 'Calendar is not writable');
    // Sync fences and write applies lock this row: keep the DAV revision and raw ETags stable together.
    const [target] = await tx.select({ id: syncTarget.id }).from(syncTarget)
      .where(and(eq(syncTarget.kind, 'events'), eq(syncTarget.targetId, calendarId))).for('share');
    if (!target) throw new HostedWriteError('read-only', 'Calendar has no events target');
    const index = await pubIndex(tx, importedPublication(calendar, account.email));
    const [name] = await tx.select().from(davObjectName).where(and(eq(davObjectName.sourceCalendarId, calendarId), eq(davObjectName.objectName, input.objectName)));
    const named = index.byHref.get(input.objectName);
    const resolved = name?.uid ?? named?.uid;
    if (bodyUid !== undefined && resolved !== undefined && resolved !== bodyUid)
      throw new HostedWriteError('uid-conflict', 'An object cannot change its UID', input.objectName);
    const uid = bodyUid ?? resolved;
    if (uid === undefined) throw new HostedWriteError('not-found', 'No such object');
    const live = index.byUid.get(uid);
    if (bodyUid !== undefined && live && decodeURIComponent(live.href) !== input.objectName)
      throw new HostedWriteError('uid-conflict', 'UID already exists in this calendar', decodeURIComponent(live.href));
    if ((input.ifNoneMatch && live) || (input.ifMatch !== undefined && (!live || input.ifMatch !== live.etag)))
      throw new HostedWriteError('precondition-failed', 'Object ETag does not match');
    if (bodyUid === undefined && !live) throw new HostedWriteError('not-found', 'No such object');
    const rows = await tx.select().from(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendarId), eq(sourceObject.groupUid, uid)));
    // A dirty group contains a provider version the client has not seen in resource yet. Using its
    // newer upstream ETag with the old DAV ETag would silently overwrite that unseen provider edit.
    if (rows.some((row) => row.dirty)) throw new HostedWriteError('precondition-failed', 'Calendar object is awaiting sync publication; refetch it');
    const existing: StoredObject[] = rows.map((row) => ({ id: row.providerObjectId, etag: row.etag ?? '',
      payload: adapter.format === 'ical' ? row.payload : z.json().parse(JSON.parse(row.payload)),
      ...(row.originalStart !== null && { originalStart: row.originalStart }) }));
    const occurrences = await tx.select().from(graphOccurrence).where(eq(graphOccurrence.sourceCalendarId, calendarId));
    const ref = { ...calendar, occurrences: async (masterId: string) => new Map(occurrences.filter((row) => row.masterId === masterId).map((row) => [row.occurrenceId, row.originalStart])) };
    return { calendar: ref, account, adapter, writes: adapter.writes, uid, existing, created: !live };
  });
}

/** Immutable check-phase snapshot passed across the provider call. */
type Checked = Awaited<ReturnType<typeof check>>;

/** Translate provider outcomes without confusing one object's refusal with invalid account credentials. */
async function providerWrite(deps: WriteDeps, checked: Checked, applyPartial: (result: WriteResult) => Promise<void>, call: (ctx: Awaited<ReturnType<typeof accountContext>>) => Promise<WriteResult>) {
  const signal = AbortSignal.timeout(20_000);
  try {
    const result = await call(await accountContext(deps, checked.account, signal));
    signal.throwIfAborted();
    return result;
  } catch (caught) {
    const error = caught instanceof ProviderPartialWriteError ? caught.cause : caught;
    if (caught instanceof ProviderPartialWriteError) await applyPartial(caught.partial);
    if (error instanceof AuthFailedError) {
      await requireReauth(checked.account, error.message);
      throw new HostedWriteError('read-only', 'Account needs to reconnect');
    }
    if (error instanceof ProviderConflictError) throw new HostedWriteError('precondition-failed', error.message);
    if (error instanceof ProviderWriteRejectedError) {
      const code = error.reason === 'invalid-data' ? 'invalid-calendar-data' : error.reason === 'not-found' ? 'precondition-failed' : error.reason;
      throw new HostedWriteError(code, error.message);
    }
    if (signal.aborted || error instanceof ProviderThrottledError || error instanceof ProviderUnavailableError
      || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')))
      throw new HostedWriteError('provider-unavailable', 'Provider is temporarily unavailable', undefined, error instanceof ProviderThrottledError ? error.retryAfterMs : undefined);
    throw error;
  }
}

/** Persist only an accepted provider result, protecting it from a snapshot already in progress. */
async function apply(deps: WriteDeps, principal: Principal, checked: Checked, input: Preconditions, result: WriteResult, deleting: boolean) {
  const { calendar, adapter, created } = checked;
  const groups = new Set(result.upserts.map((object) => object.groupUid));
  if (groups.size > 1) throw new Error('Provider write returned several UID groups');
  const uid = result.upserts[0]?.groupUid ?? checked.uid;
  if (uid !== checked.uid && !created) throw new Error('Provider changed an existing UID');
  await withTenant(principal.tenantId, async (tx) => {
    await lockCalendarWrites(tx, calendar.id);
    const [target] = await tx.select().from(syncTarget)
      .where(and(eq(syncTarget.kind, 'events'), eq(syncTarget.targetId, calendar.id))).for('update');
    if (!target) throw new Error('Imported calendar has no events target');
    if (created && uid !== checked.uid) {
      const index = await pubIndex(tx, importedPublication(calendar, checked.account.email));
      const conflict = index.byUid.get(uid);
      if (conflict) throw new HostedWriteError('uid-conflict', 'Provider UID already exists in this calendar', decodeURIComponent(conflict.href));
    }
    await applyRawObjects(tx, { tenantId: principal.tenantId, calendar, format: adapter.format, seenGeneration: target.leaseVersion }, result);
    const normalizer = normalizers[adapter.format];
    if (!normalizer) throw new Error(`No normalizer for ${adapter.format}`);
    const changes = await normalizeDirtyGroups(tx, calendar, normalizer, deps.log, { objectNames: false, groups: [uid] });
    // Retain the name on resource tombstones so a sync reports the href clients previously saw.
    for (const change of changes) if (change.op === 'upsert') change.objectName = input.objectName;
    if (deleting) await tx.delete(davObjectName).where(and(eq(davObjectName.sourceCalendarId, calendar.id), eq(davObjectName.uid, uid)));
    else if (created) await tx.insert(davObjectName).values({ tenantId: principal.tenantId, sourceCalendarId: calendar.id, uid, objectName: input.objectName })
      .onConflictDoUpdate({ target: [davObjectName.sourceCalendarId, davObjectName.uid], set: { objectName: input.objectName } });
    // A running sync's completion must not postpone the correction run requested here.
    await tx.update(syncTarget).set({ nextRunAt: sql`now()`, wakeGeneration: sql`${syncTarget.wakeGeneration} + 1` }).where(eq(syncTarget.id, target.id));
    await audit(tx, principal, deleting ? 'event.delete' : created ? 'event.create' : 'event.update', { type: 'calendar', id: calendar.id }, { uid });
    await recordChanges(tx, changes);
  });
}

/** Write exactly one UID group upstream; callers must refetch its provider-normalized representation. */
export async function putImported(deps: WriteDeps, principal: Principal, calendarId: SourceCalendarId,
  input: { objectName: string; ics: string; ifMatch?: string; ifNoneMatch?: '*' }): Promise<{ created: boolean }> {
  const validated = validateObject(input.ics);
  if (!validated.ok) throw new HostedWriteError(validated.code, validated.detail);
  const checked = await check(deps, principal, calendarId, input, validated.resource.uid);
  const result = await providerWrite(deps, checked, (partial) => apply(deps, principal, checked, input, partial, false), (ctx) => checked.writes.put(ctx, checked.calendar, input.ics, checked.existing));
  await apply(deps, principal, checked, input, result, false);
  return { created: checked.created };
}

/** Delete the entire upstream UID group, then publish its deletion locally. */
export async function deleteImported(deps: WriteDeps, principal: Principal, calendarId: SourceCalendarId,
  input: { objectName: string; ifMatch?: string }): Promise<void> {
  const checked = await check(deps, principal, calendarId, input);
  const result = await providerWrite(deps, checked, (partial) => apply(deps, principal, checked, input, partial, false), (ctx) => checked.writes.delete(ctx, checked.calendar, checked.existing));
  await apply(deps, principal, checked, input, result, true);
}
