/** The single event read projection for REST list, get, occurrences, changes and export. */
import { project, type EventResource, type PublicationSpec } from '@supercal/core';
import type { SourceCalendar } from '@supercal/db';
import type { Access } from './access.ts';

export function memberSpec(calendarId: string, ownerAddresses: string[] = []): PublicationSpec {
  return { id: calendarId, kind: 'passthrough', privacy: 'full', audience: 'member',
    filters: { hideDeclined: false, hideCancelled: false, hideAllDay: false }, keepAlarms: true, ownerAddresses, uidSecret: null };
}

/** Read grants redact private components; editors and owners see the stored data. */
export async function readResources<T extends { data: EventResource | null }>(calendar: SourceCalendar, access: Access, rows: T[]): Promise<(T & { data: EventResource })[]> {
  if (access !== 'read') return rows.flatMap((row) => row.data ? [{ ...row, data: row.data }] : []);
  const projected = await project(memberSpec(calendar.id), rows.flatMap((row) => row.data ? [{ sourceCalendarId: calendar.id, priority: 0, ownerAddresses: [], resource: row.data }] : []));
  const byUid = new Map(projected.map((object) => [object.sourceUid, object.resource]));
  return rows.flatMap((row) => {
    const data = row.data && byUid.get(row.data.uid);
    return data ? [{ ...row, data }] : [];
  });
}
