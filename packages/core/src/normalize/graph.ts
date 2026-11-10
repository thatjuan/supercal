/**
 * The `graph` normaliser: Microsoft Graph event JSON (fetched with `Prefer: outlook.timezone="UTC"`)
 * sharing one iCalUId becomes one EventResource. The group is a single event or a series master
 * plus its exception occurrences, as the Microsoft adapter stores them.
 *
 * - The series zone is `recurrence.range.recurrenceTimeZone`, else `originalStartTimeZone`: a
 *   Windows name mapped to IANA through CLDR (`windows-iana`, territory 001). An unknown or custom
 *   zone throws `UnknownTimeZoneError`; it never falls back to UTC.
 * - `patternedRecurrence` becomes an RRULE (`graphRrule`). Shapes whose mapping is unverified throw
 *   `UnsupportedRecurrenceError` rather than being approximated.
 * - Exceptions become overrides whose RECURRENCE-ID is their `originalStart` in the series zone.
 * - Cancelled occurrences arrive as opaque ids. The adapter resolves them to original starts and
 *   annotates the master with `@supercal.cancelled`; each resolved one becomes an EXDATE, and an
 *   unresolved one leaves the resource published but `incomplete`. An occurrence missing from a
 *   listing is never taken for a cancellation.
 */
import { Temporal } from "@js-temporal/polyfill";
import { findIana } from "windows-iana";
import { z } from "zod";
import { UnknownTimeZoneError } from "../time.ts";
import type { EventResource } from "../model.ts";
import type { Completeness, SourceObject } from "./ical.ts";
import { compact, EMAIL, escapeText, quoteParam, toResource, utcStamp, validZone, webUrl } from "./lines.ts";

/** The completeness reason of a resource with a cancelled occurrence whose original start is unknown. */
export const UNRESOLVED_CANCELLATION = "graph-cancelled-occurrence-unresolved";

/** The master's annotation, written by the adapter: each cancelled occurrence id and its original start, or null when unresolved. */
export const CANCELLED_ANNOTATION = "@supercal.cancelled";

/** A recurrence shape whose iCalendar mapping is unverified, so it is rejected instead of approximated. */
export class UnsupportedRecurrenceError extends Error {
  override readonly name = "UnsupportedRecurrenceError";
  constructor(reason: string) {
    super(`graph-recurrence-unsupported: ${reason}`);
  }
}

const Weekday = z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
type Weekday = z.infer<typeof Weekday>;
const GraphTime = z.object({ dateTime: z.string(), timeZone: z.string() });
const Email = z.object({ name: z.string().nullish(), address: z.string().nullish() });

/** Graph sends every pattern and range field whatever the type (0, "" or a default), so only the type's own fields are read. */
const Recurrence = z.object({
  pattern: z.object({
    type: z.enum(["daily", "weekly", "absoluteMonthly", "relativeMonthly", "absoluteYearly", "relativeYearly"]),
    interval: z.number().int(),
    daysOfWeek: z.array(Weekday).nullish(),
    firstDayOfWeek: Weekday.nullish(),
    dayOfMonth: z.number().int().nullish(),
    month: z.number().int().nullish(),
    index: z.enum(["first", "second", "third", "fourth", "last"]).nullish(),
  }),
  range: z.object({
    type: z.enum(["endDate", "noEnd", "numbered"]),
    startDate: z.string(),
    endDate: z.string().nullish(),
    numberOfOccurrences: z.number().int().nullish(),
    recurrenceTimeZone: z.string().nullish(),
  }),
});
export type GraphRecurrence = z.infer<typeof Recurrence>;

/** The fields of a Graph event the normaliser reads; anything else in the payload is ignored. */
export const GraphEvent = z.object({
  id: z.string(),
  iCalUId: z.string().nullish(),
  type: z.enum(["singleInstance", "occurrence", "exception", "seriesMaster"]).nullish(),
  seriesMasterId: z.string().nullish(),
  subject: z.string().nullish(),
  body: z.object({ contentType: z.string().nullish(), content: z.string().nullish() }).nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  start: GraphTime,
  end: GraphTime,
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  isReminderOn: z.boolean().nullish(),
  reminderMinutesBeforeStart: z.number().int().nullish(),
  originalStart: z.string().nullish(),
  originalStartTimeZone: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  showAs: z.string().nullish(),
  sensitivity: z.string().nullish(),
  organizer: z.object({ emailAddress: Email.nullish() }).nullish(),
  attendees: z.array(z.object({ type: z.string().nullish(), status: z.object({ response: z.string().nullish() }).nullish(), emailAddress: Email.nullish() })).nullish(),
  onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
  recurrence: Recurrence.nullish(),
  cancelledOccurrences: z.array(z.string()).nullish(),
  [CANCELLED_ANNOTATION]: z.array(z.object({ id: z.string(), originalStart: z.string().nullable() })).optional(),
});
export type GraphEvent = z.infer<typeof GraphEvent>;

const WEEKDAY: Record<Weekday, string> = { sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA" };
/** Temporal's `dayOfWeek` (1 = Monday … 7 = Sunday) by Graph weekday. */
const ISO_WEEKDAY: Record<Weekday, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
const SETPOS = { first: 1, second: 2, third: 3, fourth: 4, last: -1 } as const;
const PARTSTAT: Record<string, string> = { accepted: "ACCEPTED", organizer: "ACCEPTED", declined: "DECLINED", tentativelyAccepted: "TENTATIVE" };
const CLASS: Record<string, string> = { private: "PRIVATE", confidential: "CONFIDENTIAL" };

/** The IANA zone for a Graph time-zone name: a Windows name (CLDR, territory 001) or an IANA name. Throws UnknownTimeZoneError otherwise. */
export function ianaZone(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC";
  const mapped = findIana(zone, "001")[0];
  try {
    return validZone(mapped ?? zone);
  } catch {
    throw new UnknownTimeZoneError(zone);
  }
}

/** A Graph dateTime/timeZone pair as an instant. */
function instantOf(time: z.infer<typeof GraphTime>): Temporal.Instant {
  const zone = ianaZone(time.timeZone);
  return Temporal.PlainDateTime.from(time.dateTime.replace(/Z$/, "")).toZonedDateTime(zone, { disambiguation: "compatible" }).toInstant();
}

type Series = { zone: string; allDay: boolean };

/** A DATE (all-day) or DATE-TIME property for an instant, in the series zone. */
function dateLine(name: string, instant: Temporal.Instant, { zone, allDay }: Series): string {
  const local = instant.toZonedDateTimeISO(zone).toPlainDateTime();
  if (allDay) return `${name};VALUE=DATE:${compact(local.toPlainDate().toString())}`;
  if (zone === "UTC") return `${name}:${utcStamp(instant)}`;
  return `${name};TZID=${zone}:${compact(local.toString({ smallestUnit: "second" }))}`;
}

/** Whether `date` is the occurrence `index` (first … last) of its weekday in its month. */
function isNthWeekday(date: Temporal.PlainDate, index: keyof typeof SETPOS): boolean {
  return index === "last" ? date.day + 7 > date.daysInMonth : Math.ceil(date.day / 7) === SETPOS[index];
}

/** Whether `date` matches the pattern's day rules (not its interval: the range start begins the cycle). */
function matchesPattern(date: Temporal.PlainDate, p: GraphRecurrence["pattern"]): boolean {
  const days = (p.daysOfWeek ?? []).map((d) => ISO_WEEKDAY[d]);
  switch (p.type) {
    case "daily":
      return true;
    case "weekly":
      return days.includes(date.dayOfWeek);
    case "absoluteMonthly":
      return date.day === p.dayOfMonth;
    case "absoluteYearly":
      return date.month === p.month && date.day === p.dayOfMonth;
    case "relativeMonthly":
    case "relativeYearly":
      return (p.type === "relativeMonthly" || date.month === p.month) && days.includes(date.dayOfWeek) && isNthWeekday(date, p.index ?? "first");
  }
}

/**
 * The RRULE value for a Graph recurrence, in the IANA series `zone`. An `endDate` range is
 * inclusive: a timed series gets a UTC UNTIL at the end of its last local day, an all-day one a
 * DATE. Throws UnsupportedRecurrenceError for shapes whose mapping is unverified.
 */
export function graphRrule({ pattern: p, range: r }: GraphRecurrence, { allDay, zone }: Series): string {
  if (p.interval < 1) throw new RangeError(`invalid recurrence interval ${p.interval}`);
  const days = p.daysOfWeek ?? [];
  // TODO(verification): https://github.com/thatjuan/supercal/issues/23 must confirm how Exchange
  // expands these before they are mapped; the ingest spike lists them as unverified.
  if ((p.type === "relativeMonthly" || p.type === "relativeYearly") && days.length > 1) throw new UnsupportedRecurrenceError(`${p.type} with several daysOfWeek and an index`);
  if (!matchesPattern(Temporal.PlainDate.from(r.startDate), p)) throw new UnsupportedRecurrenceError(`range startDate ${r.startDate} is not an occurrence of the ${p.type} pattern`);

  const freq = { daily: "DAILY", weekly: "WEEKLY", absoluteMonthly: "MONTHLY", relativeMonthly: "MONTHLY", absoluteYearly: "YEARLY", relativeYearly: "YEARLY" }[p.type];
  const parts = [`FREQ=${freq}`, `INTERVAL=${p.interval}`];
  if (p.type === "absoluteYearly" || p.type === "relativeYearly") parts.push(`BYMONTH=${p.month}`);
  if (p.type === "absoluteMonthly" || p.type === "absoluteYearly") parts.push(`BYMONTHDAY=${p.dayOfMonth}`);
  if (p.type === "weekly" || p.type === "relativeMonthly" || p.type === "relativeYearly") {
    if (days.length === 0) throw new RangeError(`${p.type} recurrence without daysOfWeek`);
    parts.push(`BYDAY=${days.map((d) => WEEKDAY[d]).join(",")}`);
    if (p.type === "weekly") parts.push(`WKST=${WEEKDAY[p.firstDayOfWeek ?? "sunday"]}`);
    else parts.push(`BYSETPOS=${SETPOS[p.index ?? "first"]}`);
  }
  if (r.type === "numbered") {
    if (!r.numberOfOccurrences || r.numberOfOccurrences < 1) throw new RangeError(`invalid occurrence count ${r.numberOfOccurrences}`);
    parts.push(`COUNT=${r.numberOfOccurrences}`);
  }
  if (r.type === "endDate") {
    if (!r.endDate) throw new RangeError("endDate range without endDate");
    const last = Temporal.PlainDate.from(r.endDate);
    parts.push(`UNTIL=${allDay ? compact(last.toString()) : utcStamp(last.add({ days: 1 }).toZonedDateTime(zone).toInstant().subtract({ seconds: 1 }))}`);
  }
  return parts.join(";");
}

/** Plain text from an HTML body: a minimal tag stripper (no markup survives) with the common entities decoded. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return html
    .replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] !== "#") return entities[code.toLowerCase()] ?? match;
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function personLine(name: "ORGANIZER" | "ATTENDEE", email: z.infer<typeof Email> | null | undefined, extra: (string | false)[] = []): string | null {
  if (!email?.address || !EMAIL.test(email.address)) return null;
  const params = [email.name && `CN=${quoteParam(email.name)}`, ...extra].filter(Boolean);
  return `${[name, ...params].join(";")}:mailto:${email.address}`;
}

/** The VEVENT lines of one Graph event (without BEGIN/END). */
function eventLines(uid: string, e: GraphEvent, series: Series, extra: string[]): string[] {
  const own = { ...series, allDay: e.isAllDay ?? series.allDay };
  const modified = e.lastModifiedDateTime;
  const lines = [`UID:${escapeText(uid)}`, `DTSTAMP:${utcStamp(modified ?? "1970-01-01T00:00:00Z")}`, ...extra];
  lines.push(dateLine("DTSTART", instantOf(e.start), own), dateLine("DTEND", instantOf(e.end), own));
  if (modified) lines.push(`LAST-MODIFIED:${utcStamp(modified)}`);
  if (e.isCancelled) lines.push("STATUS:CANCELLED");
  if (!e.isCancelled && e.showAs === "tentative") lines.push("STATUS:TENTATIVE");
  if (e.showAs === "free") lines.push("TRANSP:TRANSPARENT");
  const klass = CLASS[e.sensitivity ?? ""];
  if (klass) lines.push(`CLASS:${klass}`);
  if (e.subject) lines.push(`SUMMARY:${escapeText(e.subject)}`);
  const body = e.body?.content;
  if (body) {
    const html = e.body?.contentType === "html";
    const text = html ? htmlToText(body) : body;
    if (text) lines.push(`DESCRIPTION:${escapeText(text)}`);
    if (html) lines.push(`X-ALT-DESC;FMTTYPE=text/html:${escapeText(body)}`);
  }
  if (e.location?.displayName) lines.push(`LOCATION:${escapeText(e.location.displayName)}`);
  const organizer = personLine("ORGANIZER", e.organizer?.emailAddress);
  if (organizer) lines.push(organizer);
  for (const a of e.attendees ?? []) {
    const line = personLine("ATTENDEE", a.emailAddress, [
      `PARTSTAT=${PARTSTAT[a.status?.response ?? ""] ?? "NEEDS-ACTION"}`,
      `ROLE=${a.type === "optional" ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT"}`,
      a.type === "resource" && "CUTYPE=RESOURCE",
    ]);
    if (line) lines.push(line);
  }
  const meeting = webUrl(e.onlineMeeting?.joinUrl);
  if (meeting) lines.push(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${meeting}`, `URL:${meeting}`);
  if (e.isReminderOn && e.reminderMinutesBeforeStart != null) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${e.reminderMinutesBeforeStart}M`, "END:VALARM");
  return lines;
}

/**
 * Normalises one group: a single event or series master plus its exceptions. Returns null when
 * the group has no master (its exceptions alone publish nothing). Throws on malformed payloads,
 * unknown zones and unsupported recurrences; the runner then keeps the last good data, incomplete.
 */
export function normalizeGraph(objects: SourceObject[]): { resource: EventResource; completeness: Completeness } | null {
  const uid = objects[0]?.groupUid;
  if (uid === undefined) throw new RangeError("normalizeGraph needs at least one object");
  if (objects.some((o) => o.groupUid !== uid)) throw new RangeError("normalizeGraph objects must share one groupUid");

  const events = [...objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((o) => GraphEvent.parse(JSON.parse(o.payload)));
  const master = events.find((e) => !e.seriesMasterId);
  if (!master) return null;
  const exceptions = events.filter((e) => e.seriesMasterId === master.id);

  const series: Series = {
    zone: ianaZone(master.recurrence?.range.recurrenceTimeZone || master.originalStartTimeZone || master.start.timeZone),
    allDay: master.isAllDay ?? false,
  };
  const slot = (name: string, instant: string) => dateLine(name, Temporal.Instant.from(instant), series);

  const recurrence: string[] = [];
  const problems: string[] = [];
  if (master.recurrence) {
    const first = instantOf(master.start).toZonedDateTimeISO(series.zone).toPlainDate();
    // TODO(verification): https://github.com/thatjuan/supercal/issues/23 — a master that does not
    // start on its range's first day is unverified, and RFC 5545 would count DTSTART as an occurrence.
    if (!first.equals(Temporal.PlainDate.from(master.recurrence.range.startDate)))
      throw new UnsupportedRecurrenceError(`master starts on ${first}, not on its range startDate ${master.recurrence.range.startDate}`);
    recurrence.push(`RRULE:${graphRrule(master.recurrence, series)}`);
    const cancelled = master[CANCELLED_ANNOTATION] ?? (master.cancelledOccurrences ?? []).map((id) => ({ id, originalStart: null }));
    for (const exdate of new Set(cancelled.flatMap((c) => (c.originalStart ? [slot("EXDATE", c.originalStart)] : [])))) recurrence.push(exdate);
    const unresolved = cancelled.filter((c) => !c.originalStart).length;
    if (unresolved) problems.push(`${UNRESOLVED_CANCELLATION}: ${unresolved} cancelled occurrence(s) without a known original start`);
  }

  const blocks = [eventLines(uid, master, series, recurrence)];
  for (const e of exceptions) {
    if (!e.originalStart) throw new RangeError(`exception ${e.id} has no originalStart`);
    blocks.push(eventLines(uid, e, series, [slot("RECURRENCE-ID", e.originalStart)]));
  }
  return toResource(uid, blocks, problems);
}
