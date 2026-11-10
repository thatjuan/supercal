import { normalizers, validateObject, type ObjectRejection } from '@supercal/core';
import { recordChanges, resource, sourceCalendar, sourceObject, type SourceCalendar, type SourceCalendarId, type TenantTx } from '@supercal/db';
import { and, count, eq, sql } from 'drizzle-orm';
import { createLogger } from '../log.ts';
import { normalizeDirtyGroups, upsertOf } from '../sync/changes.ts';

export const HOSTED_WRITE_LOCK = 1937011298;
export const MAX_OBJECTS_PER_CALENDAR = 50_000;
/** Rejections shared by hosted writes and provider write-through, mapped by DAV and REST. */
export type HostedWriteCode = ObjectRejection | 'uid-conflict' | 'quota' | 'precondition-failed' | 'not-found' | 'read-only' | 'provider-unavailable';
/** A protocol-safe write rejection; unavailable providers may supply a retry hint in milliseconds. */
export class HostedWriteError extends Error {
  constructor(readonly code: HostedWriteCode, detail: string, readonly conflictObjectName?: string, readonly retryAfterMs?: number) { super(detail); }
}

/** Calendar locks always precede recordChanges' tenant lock. */
export async function lockCalendarWrites(tx: TenantTx, calendarId: SourceCalendarId): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${HOSTED_WRITE_LOCK}, hashtext(${calendarId}))`);
}

export async function writeObject(tx: TenantTx, calendar: SourceCalendar, input: { objectName: string; payload: string; ifMatch?: string; ifNoneMatch?: '*' }): Promise<{ created: boolean; uid: string; etag: string }> {
  await lockCalendarWrites(tx, calendar.id);
  const validated = validateObject(input.payload);
  if (!validated.ok) throw new HostedWriteError(validated.code, validated.detail);
  const uid = validated.resource.uid;
  const [existing] = await tx.select({ object: sourceObject, resource }).from(sourceObject)
    .leftJoin(resource, and(eq(resource.sourceCalendarId, sourceObject.sourceCalendarId), eq(resource.uid, sourceObject.groupUid)))
    .where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, input.objectName)));
  const live = existing && !existing.resource?.deleted;
  if ((input.ifNoneMatch && live) || (input.ifMatch !== undefined && (!live || input.ifMatch !== `"${existing.resource?.revision}"`)))
    throw new HostedWriteError('precondition-failed', 'Object ETag does not match');
  if (existing && existing.object.groupUid !== uid) throw new HostedWriteError('uid-conflict', 'An object cannot change its UID', input.objectName);
  const [sameUid] = await tx.select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), eq(resource.uid, uid)));
  if (sameUid && !sameUid.deleted && sameUid.objectName !== input.objectName)
    throw new HostedWriteError('uid-conflict', 'UID already exists in this calendar', sameUid.objectName ?? undefined);
  if (!existing) {
    const [total] = await tx.select({ count: count() }).from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
    if ((total?.count ?? 0) >= MAX_OBJECTS_PER_CALENDAR) throw new HostedWriteError('quota', 'Calendar object quota exceeded');
  }
  const normalizer = normalizers.ical;
  if (!normalizer) throw new Error('iCalendar normalizer unavailable');
  const normalized = normalizer.normalize([{ id: input.objectName, payload: input.payload, groupUid: uid, etag: '' }]);
  if (!normalized) throw new Error('Validated object normalized to nothing');
  const change = { ...upsertOf(calendar, uid, normalized.resource, normalized.completeness), objectName: input.objectName };
  const values = { tenantId: calendar.tenantId, sourceCalendarId: calendar.id, providerObjectId: input.objectName, format: 'ical' as const, payload: input.payload, etag: change.revision, groupUid: uid, dirty: false, normalizerVersion: normalizer.version };
  await tx.insert(sourceObject).values(values).onConflictDoUpdate({ target: [sourceObject.sourceCalendarId, sourceObject.providerObjectId], set: values });
  if (sameUid?.deleted && sameUid.objectName !== input.objectName)
    await tx.update(sourceCalendar).set({ syncEpoch: sql`${sourceCalendar.syncEpoch} + 1` }).where(eq(sourceCalendar.id, calendar.id));
  await recordChanges(tx, [change]);
  return { created: !existing, uid, etag: `"${change.revision}"` };
}

export async function deleteObject(tx: TenantTx, calendar: SourceCalendar, input: { objectName: string; ifMatch?: string }): Promise<void> {
  await lockCalendarWrites(tx, calendar.id);
  const [row] = await tx.select({ object: sourceObject, revision: resource.revision }).from(sourceObject)
    .leftJoin(resource, and(eq(resource.sourceCalendarId, sourceObject.sourceCalendarId), eq(resource.uid, sourceObject.groupUid)))
    .where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, input.objectName)));
  if (!row) throw new HostedWriteError('not-found', 'No such object');
  if (input.ifMatch !== undefined && input.ifMatch !== `"${row.revision}"`) throw new HostedWriteError('precondition-failed', 'Object ETag does not match');
  await tx.delete(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendar.id), eq(sourceObject.providerObjectId, input.objectName)));
  await recordChanges(tx, [{ op: 'delete', sourceCalendarId: calendar.id, uid: row.object.groupUid }]);
}

/** Rebuilds hosted data directly because it has no scheduler target. */
export async function rebuildHostedCalendar(tx: TenantTx, calendarId: SourceCalendarId): Promise<void> {
  await lockCalendarWrites(tx, calendarId);
  const [calendar] = await tx.select().from(sourceCalendar).where(eq(sourceCalendar.id, calendarId));
  const normalizer = normalizers.ical;
  if (!calendar) return; // Retention may have purged it after maintenance selected it.
  if (!normalizer) throw new Error('iCalendar normalizer unavailable');
  const changes = await normalizeDirtyGroups(tx, calendar, normalizer, createLogger(), { objectNames: true });
  await recordChanges(tx, changes);
}
