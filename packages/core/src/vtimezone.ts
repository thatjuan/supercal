/**
 * VTIMEZONE generation from IANA names, using the tzdata in `Intl`. Each transition in the range
 * becomes its own STANDARD/DAYLIGHT sub-component with an explicit DTSTART, TZOFFSETFROM and
 * TZOFFSETTO; no RRULE-based rules, so the result is exact for the range.
 *
 * Policy, applied by callers: pass a source VTIMEZONE through when the source supplied one and
 * generate only when the source gave an IANA name (Google, Graph); `addMissingTimezones` does that.
 */
import { Temporal } from "@js-temporal/polyfill";
import { componentsOf } from "./ical.ts";
import { tzidsOf } from "./accessors.ts";
import type { EventResource, JCalComponent, JCalProperty } from "./model.ts";
import { assertIanaZone, spanOf, type TimeWindow } from "./time.ts";

const MINUTE = 60_000;
const SAMPLE = 6 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** UTC offset of `tzid` at an epoch time, in seconds, per `Intl`. */
function offsetSeconds(tzid: string, epochMs: number): number {
  let f = formatters.get(tzid);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tzid, f);
  }
  const t = Math.floor(epochMs / 1000) * 1000;
  const parts = Object.fromEntries(f.formatToParts(t).map((p) => [p.type, p.value]));
  const year = Number(parts.year) * (parts.era === "BC" || parts.era === "B" ? -1 : 1);
  const local = Date.UTC(year, Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((local - t) / 1000);
}

const utcOffset = (seconds: number): string => {
  const a = Math.abs(seconds);
  const hms = [Math.floor(a / 3600), Math.floor((a % 3600) / 60), a % 60];
  const text = (hms[2] ? hms : hms.slice(0, 2)).map((n) => String(n).padStart(2, "0")).join(":");
  return (seconds < 0 ? "-" : "+") + text;
};

// Local wall time of an instant under a given offset, as a jCal DATE-TIME value.
const localAt = (epochMs: number, offset: number): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs + offset * 1000)
    .toZonedDateTimeISO("UTC")
    .toPlainDateTime()
    .toString({ smallestUnit: "second" });

const observance = (kind: "standard" | "daylight", epochMs: number, from: number, to: number): JCalComponent => [
  kind,
  [
    ["dtstart", {}, "date-time", localAt(epochMs, from)],
    ["tzoffsetfrom", {}, "utc-offset", utcOffset(from)],
    ["tzoffsetto", {}, "utc-offset", utcOffset(to)],
  ],
  [],
];

/**
 * A VTIMEZONE for `tzid` covering `range`: the observance in effect at `range.from`, then one
 * sub-component per transition found by sampling every 6 h and bisecting to the minute.
 * Throws UnknownTimeZoneError for zones `Intl` does not know; never falls back to UTC.
 */
export function vtimezoneFor(tzid: string, range: TimeWindow): JCalComponent {
  assertIanaZone(tzid);
  const from = Math.floor(range.from.epochMilliseconds / MINUTE) * MINUTE;
  const to = range.to.epochMilliseconds;
  let offset = offsetSeconds(tzid, from);
  const observances: JCalComponent[] = [observance("standard", from, offset, offset)];
  for (let lo = from; lo < to; lo += SAMPLE) {
    const hi = Math.min(lo + SAMPLE, to);
    if (offsetSeconds(tzid, hi) === offset) continue;
    // Smallest whole minute in (lo, hi] whose offset differs: the transition instant.
    let a = lo;
    let b = hi;
    while (b - a > MINUTE) {
      const mid = a + Math.floor((b - a) / 2 / MINUTE) * MINUTE;
      if (offsetSeconds(tzid, mid) === offset) a = mid;
      else b = mid;
    }
    const next = offsetSeconds(tzid, b);
    observances.push(observance(next > offset ? "daylight" : "standard", b, offset, next));
    offset = next;
    lo = b - SAMPLE; // resume sampling just after the transition
  }
  const props: JCalProperty[] = [["tzid", {}, "text", tzid]];
  return ["vtimezone", props, observances];
}

/** The generation range policy: earliest DTSTART − 1 day to max(last end/UNTIL, now + 2 years). */
export function timezoneRange(resource: EventResource, now: Temporal.Instant = Temporal.Now.instant()): TimeWindow {
  const span = spanOf(resource);
  const twoYears = now.toZonedDateTimeISO("UTC").add({ years: 2 }).toInstant();
  const end = span.end === "infinity" || Temporal.Instant.compare(span.end, twoYears) < 0 ? twoYears : span.end;
  return { from: span.start.subtract({ hours: 24 }), to: end };
}

/** A copy of `resource` with a generated VTIMEZONE for each referenced TZID it lacks. */
export function addMissingTimezones(resource: EventResource, now?: Temporal.Instant): EventResource {
  const missing = [...new Set(componentsOf(resource).flatMap((c) => [...tzidsOf(c)]))].filter((id) => !resource.timezones[id]);
  if (!missing.length) return resource;
  const range = timezoneRange(resource, now);
  return { ...resource, timezones: { ...resource.timezones, ...Object.fromEntries(missing.map((id) => [id, vtimezoneFor(id, range)])) } };
}
