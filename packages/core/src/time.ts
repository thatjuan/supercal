/**
 * Time math for events, done with Temporal. ical.js only generates RRULE wall times
 * (`rruleWallTimes`); every wall time is converted to an instant here with
 * `disambiguation: 'compatible'`. Floating and all-day values are read in a caller-supplied
 * calendar zone (default UTC) for span and expansion only; they stay floating in output.
 */
import { Temporal } from "@js-temporal/polyfill";
import { getProp, getProps, propParam, propParams, propType, propValues, recurrenceId, rrule } from "./accessors.ts";
import { RecurBudgetError, rruleWallTimes, vtimezoneUtcOffset } from "./ical.ts";
import type { EventResource, JCalComponent, JCalProperty, JCalValue, Occurrence } from "./model.ts";

/** Thrown when a TZID is neither an IANA zone nor defined by a VTIMEZONE we hold. Never UTC. */
export class UnknownTimeZoneError extends Error {
  override readonly name = "UnknownTimeZoneError";
  constructor(readonly tzid: string) {
    super(`Unknown time zone: ${tzid}`);
  }
}

export type TimeWindow = { from: Temporal.Instant; to: Temporal.Instant };
export type Span = { start: Temporal.Instant; end: Temporal.Instant | "infinity" };
export type Expansion = { occurrences: Occurrence[]; truncated: boolean };

const ALL_TIME: TimeWindow = {
  from: Temporal.Instant.from("0001-01-01T00:00:00Z"),
  to: Temporal.Instant.from("9999-12-31T00:00:00Z"),
};
// Guards RRULE iteration (e.g. FREQ=MINUTELY over decades); hitting it reports `truncated`.
export const MAX_ITERATIONS = 20_000;
const MAX_RDATES = 10_000;
const MAX_OVERRIDES = 10_000;

type Wall = Temporal.PlainDateTime | Temporal.PlainDate;
/** A DATE or DATE-TIME value: wall time plus the zone it is read in (`utc` marks a `Z` value). */
type Point = { wall: Wall; zone: string; utc: boolean };
/** Event length: nominal days (wall clock) plus exact milliseconds, as RFC 5545 defines. */
type Length = { days: number; ms: number };

const ianaZones = new Map<string, boolean>();
function isIanaZone(zone: string): boolean {
  let ok = ianaZones.get(zone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      ok = true;
    } catch {
      ok = false;
    }
    ianaZones.set(zone, ok);
  }
  return ok;
}

/** Throws UnknownTimeZoneError unless `zone` is an IANA name `Intl` knows. */
export function assertIanaZone(zone: string): void {
  if (!isIanaZone(zone)) throw new UnknownTimeZoneError(zone);
}

const formatWall = (w: Wall) => (w instanceof Temporal.PlainDate ? w.toString() : w.toString({ smallestUnit: "second" }));

// Converts values of one resource. TZIDs resolve as IANA names first, then via the resource's
// own VTIMEZONE (for non-IANA source TZIDs); anything else is an UnknownTimeZoneError.
function converter(resource: EventResource, calendarZone: string) {
  assertIanaZone(calendarZone);

  const instantOf = ({ wall, zone }: Point): Temporal.Instant => {
    const dt = wall instanceof Temporal.PlainDate ? wall.toPlainDateTime() : wall;
    if (isIanaZone(zone)) return dt.toZonedDateTime(zone, { disambiguation: "compatible" }).toInstant();
    const vtz = resource.timezones[zone];
    if (!vtz) throw new UnknownTimeZoneError(zone);
    return dt.toZonedDateTime("UTC").toInstant().subtract({ seconds: vtimezoneUtcOffset(vtz, dt) });
  };

  const pointOf = (p: JCalProperty, value: JCalValue, zone = propParam(p, "tzid") ?? calendarZone): Point | null => {
    // PERIOD values (RDATE) are "start/end"; only the start is used.
    const [first] = Array.isArray(value) ? value : [value];
    const v = typeof first === "string" ? first.split("/")[0] : undefined;
    if (!v) return null;
    if (propType(p) === "date" || /^\d{4}-\d{2}-\d{2}$/.test(v)) return { wall: Temporal.PlainDate.from(v), zone: calendarZone, utc: false };
    if (v.endsWith("Z")) return { wall: Temporal.PlainDateTime.from(v.slice(0, -1)), zone: "UTC", utc: true };
    return { wall: Temporal.PlainDateTime.from(v), zone, utc: false };
  };

  const startOf = (c: JCalComponent): Point | null => {
    const p = getProp(c, "dtstart") ?? getProp(c, "recurrence-id");
    const v = p && propValues(p)[0];
    return p && v !== undefined ? pointOf(p, v) : null;
  };

  /** DTEND or DURATION as a Length; null when the component has neither. */
  const lengthOf = (c: JCalComponent, start: Point): Length | null => {
    const dtend = getProp(c, "dtend");
    const endValue = dtend && propValues(dtend)[0];
    const end = dtend && endValue !== undefined ? pointOf(dtend, endValue) : null;
    if (end) {
      if (start.wall instanceof Temporal.PlainDate && end.wall instanceof Temporal.PlainDate)
        return { days: start.wall.until(end.wall).days, ms: 0 };
      return { days: 0, ms: instantOf(end).epochMilliseconds - instantOf(start).epochMilliseconds };
    }
    const duration = getProp(c, "duration");
    const dv = duration && propValues(duration)[0];
    if (typeof dv !== "string") return null;
    const d = Temporal.Duration.from(dv);
    return { days: d.weeks * 7 + d.days, ms: Temporal.Duration.from({ hours: d.hours, minutes: d.minutes, seconds: d.seconds }).total("milliseconds") };
  };

  const defaultLength = (start: Point): Length => (start.wall instanceof Temporal.PlainDate ? { days: 1, ms: 0 } : { days: 0, ms: 0 });

  const endOf = (start: Point, length: Length): Temporal.Instant =>
    instantOf({ ...start, wall: start.wall.add({ days: length.days }) }).add({ milliseconds: length.ms });

  return { instantOf, pointOf, startOf, lengthOf, defaultLength, endOf };
}

type Converter = ReturnType<typeof converter>;

const overlaps = (o: { start: Temporal.Instant; end: Temporal.Instant }, w: TimeWindow) =>
  Temporal.Instant.compare(o.start, w.to) < 0 &&
  (Temporal.Instant.compare(o.end, w.from) > 0 || (o.start.equals(o.end) && Temporal.Instant.compare(o.start, w.from) >= 0));

// An override resolved to instants. Its own DTSTART/DTEND win; missing length falls back to the master's.
function resolveOverride(c: JCalComponent, cv: Converter, masterLength: Length | null) {
  const ridProp = getProp(c, "recurrence-id");
  const ridValue = ridProp && propValues(ridProp)[0];
  const rid = ridProp && ridValue !== undefined ? cv.pointOf(ridProp, ridValue) : null;
  const start = cv.startOf(c);
  if (!ridProp || !rid || !start) return null;
  const length = cv.lengthOf(c, start) ?? masterLength ?? cv.defaultLength(start);
  const startInstant = cv.instantOf(start);
  return {
    component: c,
    recurrenceId: recurrenceId(c) ?? formatWall(rid.wall),
    ridInstant: cv.instantOf(rid),
    thisAndFuture: propParam(ridProp, "range")?.toUpperCase() === "THISANDFUTURE",
    occurrence: { start: startInstant, end: cv.endOf(start, length), allDay: start.wall instanceof Temporal.PlainDate },
  };
}

/**
 * Occurrences of the resource that overlap `window`, sorted by start: the master's RRULE and
 * RDATEs minus EXDATEs, with overrides replacing their instance and RANGE=THISANDFUTURE overrides
 * shifting every later instance by the same offset and length. At most `limit` are returned;
 * `truncated` says more existed (or iteration hit its safety bound). An optional shared
 * budget limits RRULE values across multiple resource expansions.
 */
export function expandOccurrences(resource: EventResource, window: TimeWindow, calendarZone = "UTC", limit = 5000, budget?: { remaining: number }): Expansion {
  const cv = converter(resource, calendarZone);
  const master = resource.master;
  const masterStart = master && cv.startOf(master);
  const masterLength = master && masterStart ? (cv.lengthOf(master, masterStart) ?? cv.defaultLength(masterStart)) : null;
  const overrides = resource.overrides.flatMap((c) => resolveOverride(c, cv, masterLength) ?? []);
  const exact = new Map(overrides.map((o) => [o.ridInstant.epochMilliseconds, o]));
  const ranges = overrides.filter((o) => o.thisAndFuture).sort((a, b) => Temporal.Instant.compare(a.ridInstant, b.ridInstant));

  const found: Occurrence[] = [];
  let truncated = false;
  const excluded = new Set<number>();

  if (master && masterStart && masterLength) {
    for (const p of getProps(master, "exdate"))
      for (const v of propValues(p)) {
        const pt = cv.pointOf(p, v, propParam(p, "tzid") ?? masterStart.zone);
        if (pt) excluded.add(cv.instantOf(pt).epochMilliseconds);
      }

    // A THISANDFUTURE override can pull later instances earlier, so iterate past the window by that much.
    const backShift = Math.max(0, ...ranges.map((o) => o.ridInstant.epochMilliseconds - o.occurrence.start.epochMilliseconds));
    const horizon = window.to.epochMilliseconds + backShift;
    const until = untilCheck(master, masterStart, cv);

    const bases: { point: Point; instant: Temporal.Instant; length?: Length }[] = [];
    const rule = rrule(master);
    if (rule) {
      let n = 0;
      try {
        for (const wall of rruleWallTimes(rule.prop, masterStart.wall)) {
          if (++n > MAX_ITERATIONS || (budget && budget.remaining <= 0)) {
            truncated = true;
            break;
          }
          if (budget) budget.remaining--;
          const point = { ...masterStart, wall };
          const instant = cv.instantOf(point);
          if (until(instant) || instant.epochMilliseconds > horizon) break;
          bases.push({ point, instant });
        }
      } catch (error) {
        if (!(error instanceof RecurBudgetError)) throw error;
        truncated = true;
      }
    } else bases.push({ point: masterStart, instant: cv.instantOf(masterStart) });
    const byInstant = new Map(bases.map((base) => [base.instant.epochMilliseconds, base]));
    for (const p of getProps(master, "rdate"))
      for (const v of propValues(p)) {
        const point = cv.pointOf(p, v, propParam(p, "tzid") ?? masterStart.zone);
        if (point) {
          const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split('/') : [];
          const end = parts[1];
          const periodProperty: JCalProperty | undefined = typeof end === 'string'
            ? end.startsWith('P') ? ['duration', {}, 'duration', end] : ['dtend', propParams(p), 'date-time', end]
            : undefined;
          const length = periodProperty ? cv.lengthOf(['vevent', [periodProperty], []], point) : null;
          const instant = cv.instantOf(point);
          const prior = byInstant.get(instant.epochMilliseconds);
          if (prior && length) prior.length = length;
          else if (!prior) {
            const base = { point, instant, ...(length && { length }) };
            bases.push(base);
            byInstant.set(instant.epochMilliseconds, base);
          }
        }
      }

    const seen = new Set<number>();
    for (const { point, instant, length } of bases) {
      const key = instant.epochMilliseconds;
      if (seen.has(key) || excluded.has(key) || exact.has(key)) continue;
      seen.add(key);
      const recurrenceId = formatWall(point.wall) + (point.utc ? "Z" : "");
      // Upper bound: the last THISANDFUTURE override at or before this instant.
      let lo = 0, hi = ranges.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (Temporal.Instant.compare(ranges[mid]!.ridInstant, instant) <= 0) lo = mid + 1;
        else hi = mid;
      }
      const range = ranges[lo - 1];
      if (range) {
        const start = instant.add({ milliseconds: range.occurrence.start.epochMilliseconds - range.ridInstant.epochMilliseconds });
        const ms = range.occurrence.end.epochMilliseconds - range.occurrence.start.epochMilliseconds;
        found.push({ recurrenceId, start, end: start.add({ milliseconds: ms }), allDay: range.occurrence.allDay, component: range.component });
      } else {
        found.push({ recurrenceId, start: instant, end: cv.endOf(point, length ?? masterLength), allDay: point.wall instanceof Temporal.PlainDate, component: master });
      }
    }
  }

  for (const o of overrides)
    if (!excluded.has(o.ridInstant.epochMilliseconds)) found.push({ recurrenceId: o.recurrenceId, ...o.occurrence, component: o.component });

  const inWindow = found.filter((o) => overlaps(o, window)).sort((a, b) => Temporal.Instant.compare(a.start, b.start));
  return { occurrences: inWindow.slice(0, limit), truncated: truncated || inWindow.length > limit };
}

// Returns a predicate that is true once an instance is past the RRULE's UNTIL (inclusive bound).
// A floating UNTIL is read in DTSTART's zone; a DATE UNTIL covers that whole day.
function untilCheck(master: JCalComponent, start: Point, cv: Converter): (i: Temporal.Instant) => boolean {
  const until = rrule(master)?.until;
  if (!until) return () => false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    const dayAfter = cv.instantOf({ ...start, wall: Temporal.PlainDate.from(until).add({ days: 1 }) });
    return (i) => Temporal.Instant.compare(i, dayAfter) >= 0;
  }
  const limit = until.endsWith("Z")
    ? Temporal.Instant.from(until)
    : cv.instantOf({ ...start, wall: Temporal.PlainDateTime.from(until) });
  return (i) => Temporal.Instant.compare(i, limit) > 0;
}

/**
 * First start to last end over master and overrides. An RRULE without COUNT or UNTIL gives
 * `'infinity'`; a bounded one ends at its last occurrence's end, found by expansion,
 * or at infinity when expansion exhausts its work budget.
 */
export function spanOf(resource: EventResource, calendarZone = "UTC"): Span {
  if (resource.overrides.length > MAX_OVERRIDES) throw new RangeError('Object exceeds 10,000 overrides');
  let rdates = 0;
  for (const component of [resource.master, ...resource.overrides]) {
    if (!component) continue;
    for (const prop of getProps(component, 'rdate')) {
      rdates += propValues(prop).length;
      if (rdates > MAX_RDATES) throw new RangeError('Object exceeds 10,000 RDATE values');
    }
  }
  const cv = converter(resource, calendarZone);
  const rule = resource.master && rrule(resource.master);
  const own = ownTimings(resource, cv);
  if (rule && !rule.until && rule.count === null) return { start: earliest(own), end: "infinity" };
  const { occurrences, truncated } = expandOccurrences(resource, ALL_TIME, calendarZone, MAX_ITERATIONS);
  // Every instance excluded: fall back to the components' own timing.
  const pool = occurrences.length ? occurrences : own;
  const end = pool.reduce<Temporal.Instant | null>((m, o) => (m && Temporal.Instant.compare(m, o.end) >= 0 ? m : o.end), null);
  return { start: earliest(pool), end: truncated || !end ? "infinity" : end };
}

function earliest(pool: { start: Temporal.Instant }[]): Temporal.Instant {
  const first = pool.reduce<Temporal.Instant | null>((m, o) => (m && Temporal.Instant.compare(m, o.start) <= 0 ? m : o.start), null);
  if (!first) throw new RangeError("resource has no DTSTART");
  return first;
}

function ownTimings(resource: EventResource, cv: Converter): { start: Temporal.Instant; end: Temporal.Instant }[] {
  return [resource.master, ...resource.overrides].flatMap((c) => {
    const s = c && cv.startOf(c);
    if (!c || !s) return [];
    return [{ start: cv.instantOf(s), end: cv.endOf(s, cv.lengthOf(c, s) ?? cv.defaultLength(s)) }];
  });
}
