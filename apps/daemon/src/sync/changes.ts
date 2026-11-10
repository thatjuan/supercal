import { lastModified, organizer, revisionOf, sequence, spanOf, type Completeness, type EventResource, type Normalizer } from '@supercal/core';
import { resource, sameSpan, sourceObject, type ResourceChange, type SourceCalendar, type Span, type TenantTx } from '@supercal/db';
import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { Logger } from '../log.ts';

function* chunks<T>(items: readonly T[], size = 500): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

type Upsert = Extract<ResourceChange, { op: 'upsert' }>;

export const spanDates = ({ start, end }: ReturnType<typeof spanOf>): Span => ({
  start: new Date(start.epochMilliseconds),
  end: end === 'infinity' ? 'infinity' : new Date(end.epochMilliseconds),
});

/** The `ResourceChange` for a normalised group. Without `span`, computes it, throwing when the resource has no usable timing. */
export function upsertOf(calendar: SourceCalendar, uid: string, data: EventResource, completeness: Completeness, span?: Span): Upsert {
  const main = data.master ?? data.overrides[0] ?? null;
  const modified = main && lastModified(main);
  return {
    op: 'upsert',
    sourceCalendarId: calendar.id,
    uid,
    resource: data,
    // Completeness is part of the revision, so marking a resource incomplete is a change.
    revision: completeness === 'complete' ? revisionOf(data) : `${revisionOf(data)}.incomplete`,
    sequence: main && sequence(main),
    lastModified: modified ? new Date(modified.epochMilliseconds) : null,
    organizer: (main && organizer(main)?.address) ?? null,
    span: span ?? spanDates(spanOf(data, calendar.timezone ?? 'UTC')),
    completeness,
  };
}

/** Rebuilds dirty UID groups, retaining last good data when normalization fails. */
export async function normalizeDirtyGroups(tx: TenantTx, calendar: SourceCalendar, normalizer: Normalizer, log: Logger, { objectNames }: { objectNames: boolean }): Promise<ResourceChange[]> {
  const ofCalendar = eq(sourceObject.sourceCalendarId, calendar.id);
  const changes: ResourceChange[] = [];
  const dirty = (await tx.selectDistinct({ groupUid: sourceObject.groupUid }).from(sourceObject).where(and(ofCalendar, eq(sourceObject.dirty, true)))).map((d) => d.groupUid);
  for (const groups of chunks(dirty)) {
    const objects = await tx.select().from(sourceObject).where(and(ofCalendar, inArray(sourceObject.groupUid, groups)));
    const stored = new Map(
      (await tx.select().from(resource).where(and(eq(resource.sourceCalendarId, calendar.id), inArray(resource.uid, groups)))).map((r) => [r.uid, r]),
    );
    for (const uid of groups) {
      const members = objects.filter((o) => o.groupUid === uid);
      const before = stored.get(uid);
      let change: Upsert | null;
      try {
        const normalized = normalizer.normalize(members.map((o) => ({ id: o.providerObjectId, etag: o.etag ?? '', groupUid: uid, payload: o.payload })));
        if (!normalized) {
          // The group publishes nothing (e.g. only cancelled instances are left).
          if (before && !before.deleted) changes.push({ op: 'delete', sourceCalendarId: calendar.id, uid });
          continue;
        }
        change = upsertOf(calendar, uid, normalized.resource, normalized.completeness);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn('normalisation failed', { calendarId: calendar.id, uid, providerObjectIds: members.map((o) => o.providerObjectId), error: reason });
        const last = stored.get(uid);
        change = last?.data && last.span ? upsertOf(calendar, uid, last.data, { incomplete: reason }, last.span) : null;
      }
      if (change && objectNames && members[0]) change.objectName = members[0].providerObjectId;
      if (change && (!before || before.deleted || before.revision !== change.revision || !before.span || !sameSpan(before.span, change.span))) changes.push(change);
    }
    await tx
      .update(sourceObject)
      .set({ dirty: false, normalizerVersion: normalizer.version })
      .where(and(ofCalendar, inArray(sourceObject.groupUid, groups)));
  }

  // Resources whose group has no objects left (deleted, swept, or moved away).
  const orphans = await tx
    .select({ uid: resource.uid })
    .from(resource)
    .where(
      and(
        eq(resource.sourceCalendarId, calendar.id),
        eq(resource.deleted, false),
        notExists(tx.select({ one: sql`1` }).from(sourceObject).where(and(ofCalendar, eq(sourceObject.groupUid, resource.uid)))),
      ),
    );
  for (const { uid } of orphans) changes.push({ op: 'delete', sourceCalendarId: calendar.id, uid });
  return changes;
}
