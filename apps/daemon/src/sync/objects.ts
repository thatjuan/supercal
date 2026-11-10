/** Raw-object persistence shared by sync and synchronous provider write-back. */
import { graphOccurrence, sourceObject, type SourceCalendar, type SourceCalendarId, type SourceFormat, type TenantId, type TenantTx } from '@supercal/db';
import type { SyncPage } from '@supercal/providers';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

/** Rows per statement, well under Postgres's bind-parameter limit. */
const BATCH = 500;

/** Partition raw pages without exceeding the statement parameter bound. */
function* chunks<T>(items: readonly T[], size = BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Marks every object of `groups` dirty, after one of their objects moved or went away. */
export async function markGroupsDirty(tx: TenantTx, calendarId: SourceCalendarId, groups: readonly string[]) {
  for (const batch of chunks([...new Set(groups)]))
    await tx.update(sourceObject).set({ dirty: true }).where(and(eq(sourceObject.sourceCalendarId, calendarId), inArray(sourceObject.groupUid, batch)));
}

/** Writes one page of raw objects, stamping each with the lease version as its `seen_generation` for the snapshot sweep. */
export async function applyRawObjects(tx: TenantTx, { tenantId, calendar, format, seenGeneration }: { tenantId: TenantId; calendar: SourceCalendar; format: SourceFormat; seenGeneration: number }, page: Pick<SyncPage, 'upserts' | 'deletes' | 'deleteGroupsOf' | 'occurrences'>) {
  const where = (ids: string[]) => and(eq(sourceObject.sourceCalendarId, calendar.id), inArray(sourceObject.providerObjectId, ids));
  const touched = page.upserts.filter((o) => o.payload === null).map((o) => o.id);
  for (const batch of chunks(touched)) await tx.update(sourceObject).set({ seenGeneration }).where(where(batch));

  // Bound both bind parameters and payload bytes in each insert; one oversized object stands alone.
  const rows = page.upserts.filter((o) => o.payload !== null).map((o) => ({ ...o, payload: typeof o.payload === 'string' ? o.payload : JSON.stringify(o.payload) }));
  /** Partition upserts by both row count and serialized payload size. */
  function* batches() {
    let batch: typeof rows = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.payload);
      if (batch.length && (batch.length >= BATCH || bytes + size > 8 * 1024 * 1024)) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(row);
      bytes += size;
    }
    if (batch.length) yield batch;
  }
  for (const batch of batches()) {
    // An object that moved to another group leaves its old group to rebuild.
    const moved = await tx
      .select({ groupUid: sourceObject.groupUid })
      .from(sourceObject)
      .where(and(where(batch.map((o) => o.id)), or(...batch.map((o) => and(eq(sourceObject.providerObjectId, o.id), sql`${sourceObject.groupUid} <> ${o.groupUid}`)))));
    await markGroupsDirty(tx, calendar.id, moved.map((m) => m.groupUid));
    await tx
      .insert(sourceObject)
      .values(
        batch.map((o) => ({
          tenantId,
          sourceCalendarId: calendar.id,
          providerObjectId: o.id,
          format,
          payload: o.payload,
          etag: o.etag,
          groupUid: o.groupUid,
          originalStart: o.originalStart ?? null,
          seenGeneration,
          dirty: true,
        })),
      )
      .onConflictDoUpdate({
        target: [sourceObject.sourceCalendarId, sourceObject.providerObjectId],
        set: {
          format: sql`excluded.format`,
          payload: sql`excluded.payload`,
          etag: sql`excluded.etag`,
          groupUid: sql`excluded.group_uid`,
          originalStart: sql`excluded.original_start`,
          seenGeneration: sql`excluded.seen_generation`,
          // An unchanged payload in an unchanged group needs no re-normalisation.
          dirty: sql`${sourceObject.dirty} or ${sourceObject.payload} is distinct from excluded.payload or ${sourceObject.groupUid} is distinct from excluded.group_uid`,
        },
      });
  }

  for (const batch of chunks(page.deletes)) {
    const gone = await tx.delete(sourceObject).where(where(batch)).returning({ groupUid: sourceObject.groupUid });
    await markGroupsDirty(tx, calendar.id, gone.map((g) => g.groupUid));
  }

  for (const batch of chunks(page.deleteGroupsOf ?? [])) {
    const groups = await tx.selectDistinct({ groupUid: sourceObject.groupUid }).from(sourceObject).where(where(batch));
    if (!groups.length) continue;
    await tx.delete(sourceObject).where(and(eq(sourceObject.sourceCalendarId, calendar.id), inArray(sourceObject.groupUid, groups.map((g) => g.groupUid))));
  }

  for (const batch of chunks(page.occurrences ?? []))
    await tx
      .insert(graphOccurrence)
      .values(batch.map((o) => ({ tenantId, sourceCalendarId: calendar.id, ...o })))
      .onConflictDoUpdate({ target: [graphOccurrence.sourceCalendarId, graphOccurrence.masterId, graphOccurrence.occurrenceId], set: { originalStart: sql`excluded.original_start` } });
}

