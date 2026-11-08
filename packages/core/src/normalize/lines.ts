/**
 * iCalendar line building shared by the JSON normalisers (`google`, `graph`): they write VEVENT
 * content lines from provider JSON, and `toResource` parses them back into an EventResource with
 * generated VTIMEZONEs, so every value goes through the same parser as CalDAV data.
 */
import { Temporal } from "@js-temporal/polyfill";
import { parseCalendar } from "../ical.ts";
import { assertIanaZone } from "../time.ts";
import { addMissingTimezones } from "../vtimezone.ts";
import type { EventResource } from "../model.ts";
import type { Completeness } from "./ical.ts";

const ZONE = /^[A-Za-z0-9_+\-/]+$/;
export const EMAIL = /^[^\s"<>:;,\\]+@[^\s"<>:;,\\]+$/;

export const escapeText = (s: string) =>
  s.replaceAll("\\", "\\\\").replace(/\r\n?/g, "\n").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
export const quoteParam = (s: string) => `"${s.replace(/["\x00-\x1f\x7f]/g, "")}"`;
export const compact = (s: string) => s.replace(/[-:]/g, "");
export const utcStamp = (instant: string | Temporal.Instant) => compact(Temporal.Instant.from(instant).toString({ smallestUnit: "second" }));

/** `zone` when it is a safe TZID and an IANA zone `Intl` knows; otherwise RangeError or UnknownTimeZoneError. */
export function validZone(zone: string): string {
  if (!ZONE.test(zone)) throw new RangeError(`invalid time zone ${zone}`);
  assertIanaZone(zone);
  return zone;
}

/** An http(s) URL as a property value, or null for anything else. */
export function webUrl(uri: string | null | undefined): string | null {
  const url = uri ? URL.parse(uri) : null;
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
}

/**
 * Parses VEVENT blocks (lines without BEGIN/END) sharing `uid` into a resource with VTIMEZONEs
 * for its IANA zones. Parse errors and `problems` mark it incomplete.
 */
export function toResource(uid: string, blocks: string[][], problems: string[] = []): { resource: EventResource; completeness: Completeness } {
  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Supercal//EN", ...blocks.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
  const parsed = parseCalendar(text);
  const resource = parsed.resources.find((r) => r.uid === uid);
  if (!resource) throw new RangeError(`no VEVENT for ${uid}: ${parsed.errors.map((e) => e.message).join("; ")}`);
  const all = [...problems, ...parsed.errors.map((e) => `${e.component}: ${e.message}`)];
  return { resource: addMissingTimezones(resource), completeness: all.length ? { incomplete: all.join("; ") } : "complete" };
}
