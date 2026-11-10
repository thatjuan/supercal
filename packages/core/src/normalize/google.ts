/**
 * The `google` normaliser: Google Calendar event JSON (`events.list` with `singleEvents=false`)
 * that shares one iCalUID becomes one EventResource. The master carries the recurrence lines and
 * an EXDATE per cancelled instance; every other exception becomes an override whose RECURRENCE-ID
 * is its `originalStartTime` in the master's zone. Zones are IANA names, so VTIMEZONEs are
 * generated (`addMissingTimezones`). Explicit reminders become VALARMs for device editing.
 */
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { EventResource } from "../model.ts";
import type { Completeness, SourceObject } from "./ical.ts";
import { compact, EMAIL, escapeText, quoteParam, toResource, utcStamp, validZone, webUrl } from "./lines.ts";

const GoogleTime = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() });
const GooglePerson = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  optional: z.boolean().optional(),
  resource: z.boolean().optional(),
});

/** The fields of a Google event the normaliser reads; anything else in the payload is ignored. */
export const GoogleEvent = z.object({
  id: z.string(),
  iCalUID: z.string().optional(),
  status: z.string().optional(),
  eventType: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  updated: z.string().optional(),
  sequence: z.number().int().optional(),
  start: GoogleTime.optional(),
  end: GoogleTime.optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: GoogleTime.optional(),
  transparency: z.string().optional(),
  visibility: z.string().optional(),
  organizer: GooglePerson.optional(),
  attendees: z.array(GooglePerson).optional(),
  conferenceData: z.object({ entryPoints: z.array(z.object({ entryPointType: z.string().optional(), uri: z.string().optional() })).optional() }).optional(),
  hangoutLink: z.string().optional(),
  reminders: z.object({ useDefault: z.boolean().optional(), overrides: z.array(z.object({ method: z.string(), minutes: z.number().int().nonnegative() })).optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof GoogleEvent>;
type GoogleTime = z.infer<typeof GoogleTime>;
type GooglePerson = z.infer<typeof GooglePerson>;

/** Event types that are not calendar events for our purposes. `outOfOffice` and `focusTime` map as ordinary busy events. */
const SKIPPED_TYPES = new Set(["workingLocation", "birthday"]);

const PARTSTAT: Record<string, string> = { needsAction: "NEEDS-ACTION", accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE" };
const CLASS: Record<string, string> = { private: "PRIVATE", confidential: "CONFIDENTIAL", public: "PUBLIC" };
const STATUS: Record<string, string> = { confirmed: "CONFIRMED", tentative: "TENTATIVE" };
const TRANSP: Record<string, string> = { opaque: "OPAQUE", transparent: "TRANSPARENT" };

const RECURRENCE_LINE = /^(RRULE|RDATE|EXDATE)(;[^:\r\n]*)?:[^\r\n]+$/;
const HTML = /<\/?[a-z][^>]*>/i;

/**
 * A DATE or DATE-TIME property for a Google time: all-day `date` as VALUE=DATE, a `dateTime` in
 * `zone` (TZID) when one is known, else in UTC.
 */
function dateLine(name: string, time: GoogleTime, zone: string | undefined): string {
  if (time.date) return `${name};VALUE=DATE:${compact(Temporal.PlainDate.from(time.date).toString())}`;
  if (!time.dateTime) throw new RangeError(`${name} has neither date nor dateTime`);
  if (!zone) return `${name}:${utcStamp(time.dateTime)}`;
  const local = Temporal.Instant.from(time.dateTime).toZonedDateTimeISO(validZone(zone)).toPlainDateTime().toString({ smallestUnit: "second" });
  return `${name};TZID=${zone}:${compact(local)}`;
}

/** A recurrence slot (RECURRENCE-ID or EXDATE) in the master's value type and zone. */
function slotLine(name: string, original: GoogleTime, master: { allDay: boolean; zone: string | undefined }): string {
  if (master.allDay) {
    const date = original.date ?? original.dateTime?.slice(0, 10);
    if (!date) throw new RangeError(`${name} has no original start`);
    return dateLine(name, { date }, undefined);
  }
  return dateLine(name, original, master.zone);
}

function personLine(name: "ORGANIZER" | "ATTENDEE", person: GooglePerson): string | null {
  if (!person.email || !EMAIL.test(person.email)) return null;
  const params = [
    person.displayName && `CN=${quoteParam(person.displayName)}`,
    name === "ATTENDEE" && `PARTSTAT=${PARTSTAT[person.responseStatus ?? ""] ?? "NEEDS-ACTION"}`,
    name === "ATTENDEE" && `ROLE=${person.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT"}`,
    name === "ATTENDEE" && person.resource && "CUTYPE=RESOURCE",
  ].filter(Boolean);
  return `${[name, ...params].join(";")}:mailto:${person.email}`;
}

const conferenceUrl = (e: GoogleEvent) => webUrl(e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? e.hangoutLink);

/** The VEVENT lines of one Google event (without BEGIN/END). */
function eventLines(uid: string, e: GoogleEvent, zone: string | undefined, extra: string[]): string[] {
  if (!e.start || !e.end) throw new RangeError(`event ${e.id} has no start or end`);
  const lines = [`UID:${escapeText(uid)}`, `DTSTAMP:${utcStamp(e.updated ?? "1970-01-01T00:00:00Z")}`, ...extra];
  lines.push(dateLine("DTSTART", e.start, e.start.timeZone ?? zone), dateLine("DTEND", e.end, e.end.timeZone ?? e.start.timeZone ?? zone));
  if (e.updated) lines.push(`LAST-MODIFIED:${utcStamp(e.updated)}`);
  if (e.sequence !== undefined) lines.push(`SEQUENCE:${e.sequence}`);
  const status = STATUS[e.status ?? ""];
  if (status) lines.push(`STATUS:${status}`);
  const transp = TRANSP[e.transparency ?? ""];
  if (transp) lines.push(`TRANSP:${transp}`);
  const klass = CLASS[e.visibility ?? ""];
  if (klass) lines.push(`CLASS:${klass}`);
  if (e.summary !== undefined) lines.push(`SUMMARY:${escapeText(e.summary)}`);
  if (e.description !== undefined) {
    lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (HTML.test(e.description)) lines.push(`X-ALT-DESC;FMTTYPE=text/html:${escapeText(e.description)}`);
  }
  if (e.location !== undefined) lines.push(`LOCATION:${escapeText(e.location)}`);
  const organizer = e.organizer && personLine("ORGANIZER", e.organizer);
  if (organizer) lines.push(organizer);
  for (const attendee of e.attendees ?? []) {
    const line = personLine("ATTENDEE", attendee);
    if (line) lines.push(line);
  }
  const meeting = conferenceUrl(e);
  if (meeting) lines.push(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${meeting}`, `URL:${meeting}`);
  if (!e.reminders?.useDefault) for (const reminder of e.reminders?.overrides ?? []) {
    if (reminder.method !== 'popup' && reminder.method !== 'email') continue;
    lines.push('BEGIN:VALARM', `ACTION:${reminder.method === 'email' ? 'EMAIL' : 'DISPLAY'}`, `TRIGGER:-PT${reminder.minutes}M`, 'END:VALARM');
  }
  return lines;
}

/**
 * Normalises every Google event of one group (iCalUID): at most one master plus its exceptions.
 * Returns null when the group publishes nothing: a cancelled or skipped master, or only cancelled
 * instances without a master. Throws on malformed payloads; the runner then keeps the last good data.
 */
export function normalizeGoogle(objects: SourceObject[]): { resource: EventResource; completeness: Completeness } | null {
  const uid = objects[0]?.groupUid;
  if (uid === undefined) throw new RangeError("normalizeGoogle needs at least one object");
  if (objects.some((o) => o.groupUid !== uid)) throw new RangeError("normalizeGoogle objects must share one groupUid");

  const events = [...objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((o) => GoogleEvent.parse(JSON.parse(o.payload)));
  const master = events.find((e) => !e.recurringEventId);
  if (master && (master.status === "cancelled" || SKIPPED_TYPES.has(master.eventType ?? ""))) return null;
  const exceptions = events.filter((e) => e.recurringEventId && !SKIPPED_TYPES.has(e.eventType ?? ""));
  const live = exceptions.filter((e) => e.status !== "cancelled");
  if (!master && live.length === 0) return null;

  const context = { allDay: master?.start?.date !== undefined, zone: master?.start?.timeZone };
  const blocks: string[][] = [];
  if (master) {
    for (const line of master.recurrence ?? []) if (!RECURRENCE_LINE.test(line)) throw new RangeError(`unsupported recurrence line in ${master.id}`);
    const exdates = exceptions.filter((e) => e.status === "cancelled" && e.originalStartTime).map((e) => slotLine("EXDATE", e.originalStartTime ?? {}, context));
    blocks.push(eventLines(uid, master, context.zone, [...(master.recurrence ?? []), ...new Set(exdates)]));
  }
  for (const e of live) {
    if (!e.originalStartTime) throw new RangeError(`exception ${e.id} has no originalStartTime`);
    const own = master ? context : { allDay: e.originalStartTime.date !== undefined, zone: e.originalStartTime.timeZone ?? e.start?.timeZone };
    blocks.push(eventLines(uid, e, own.zone, [slotLine("RECURRENCE-ID", e.originalStartTime, own)]));
  }

  return toResource(uid, blocks);
}
