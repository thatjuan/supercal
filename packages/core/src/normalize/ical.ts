/**
 * The `ical` normaliser (CalDAV and ICS sources): raw iCalendar objects that share one group UID
 * become one EventResource. Source VTIMEZONEs are kept as supplied.
 */
import { compareRevision, recurrenceId, tzidsOf } from "../accessors.ts";
import { parseCalendar } from "../ical.ts";
import type { EventResource, JCalComponent } from "../model.ts";

/** One provider object: a CalDAV object resource, or one per-UID group of an ICS feed. */
export type SourceObject = { id: string; etag: string; groupUid: string; payload: string };
export type Completeness = "complete" | { incomplete: string };

/**
 * Merges the components every object contributes to its group UID. When two objects carry the
 * same component (both masters, or the same RECURRENCE-ID), the higher SEQUENCE wins, then the
 * later LAST-MODIFIED, then the lower object id. Parse errors mark the result incomplete.
 * All objects must share one `groupUid`.
 */
export function normalizeIcal(objects: SourceObject[]): { resource: EventResource; completeness: Completeness } {
  const uid = objects[0]?.groupUid;
  if (uid === undefined) throw new RangeError("normalizeIcal needs at least one object");
  if (objects.some((o) => o.groupUid !== uid)) throw new RangeError("normalizeIcal objects must share one groupUid");

  const picked = new Map<string | null, JCalComponent>();
  const sourceZones: EventResource["timezones"] = {};
  const problems: string[] = [];
  for (const object of [...objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const parsed = parseCalendar(object.payload);
    for (const e of parsed.errors) problems.push(`${object.id}: ${e.component}: ${e.message}`);
    const resource = parsed.resources.find((r) => r.uid === uid);
    if (!resource) continue;
    for (const [id, tz] of Object.entries(resource.timezones)) sourceZones[id] ??= tz;
    for (const component of [resource.master, ...resource.overrides]) {
      if (!component) continue;
      const key = recurrenceId(component);
      const current = picked.get(key);
      // Objects are visited in id order, so a tie keeps the lower id.
      if (!current || compareRevision(component, current) > 0) picked.set(key, component);
    }
  }

  const overrides = [...picked]
    .flatMap(([key, c]) => (key === null ? [] : [[key, c] as const]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, c]) => c);
  const used = new Set([...picked.values()].flatMap((c) => [...tzidsOf(c)]));
  const timezones = Object.fromEntries(Object.entries(sourceZones).filter(([id]) => used.has(id)));
  const resource: EventResource = { uid, master: picked.get(null) ?? null, overrides, timezones };
  if (!picked.size) problems.push(`no VEVENT with UID ${uid}`);
  return { resource, completeness: problems.length ? { incomplete: problems.join("; ") } : "complete" };
}

/** UIDs of the VEVENTs in a payload, in order. The ICS adapter groups a feed body by these. */
export const groupUidsOf = (payload: string): string[] => parseCalendar(payload).resources.map((r) => r.uid);
