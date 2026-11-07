import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import ICAL from "ical.js";
import { UnknownTimeZoneError, getProp, propValues, subcomponents, vtimezoneFor } from "../src/index.ts";

const ZONES = [
  "America/New_York",
  "Europe/Berlin",
  "America/Sao_Paulo",
  "Africa/Casablanca",
  "America/Santiago",
  "America/Nuuk",
  "Europe/Kyiv",
  "Asia/Tehran",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
];
const FROM = Date.UTC(2025, 0, 1);
const TO = Date.UTC(2035, 0, 1);
const SIX_HOURS = 6 * 3600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

// Offset in minutes per Intl (the reference), as in spikes/feed/src/q4-vtimezone.ts.
function intlOffsetMinutes(tz: string, t: number): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  const parts = f.formatToParts(t);
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t) / 60000;
}

// Offset in minutes ical.js derives from the generated VTIMEZONE for a UTC instant.
function icalOffsetMinutes(zone: ICAL.Timezone, t: number): number {
  const local = ICAL.Time.fromJSDate(new Date(t), true).convertToZone(zone);
  return (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - t) / 60000;
}

const minutes = (offset: string) => {
  const [h = 0, m = 0] = offset.slice(1).split(":").map(Number);
  return (offset.startsWith("-") ? -1 : 1) * (h * 60 + m);
};

describe("vtimezoneFor", () => {
  for (const tz of ZONES)
    test(`${tz} matches Intl every 6 h over 2025–2034`, () => {
      // Range policy pads the start by a day, so the first sample is inside the first observance.
      const vtz = vtimezoneFor(tz, { from: Temporal.Instant.fromEpochMilliseconds(FROM - 86_400_000), to: Temporal.Instant.fromEpochMilliseconds(TO) });
      const zone = new ICAL.Timezone(new ICAL.Component(ICAL.parse(ICAL.stringify(["vcalendar", [], [vtz]]))).getFirstSubcomponent("vtimezone")!);
      const transitions = subcomponents(vtz).slice(1).map((o) => {
        const value = (name: string) => String(propValues(getProp(o, name)!)[0]);
        const from = minutes(value("tzoffsetfrom"));
        return { at: Date.parse(`${value("dtstart")}Z`) - from * 60_000, from, to: minutes(value("tzoffsetto")) };
      });
      // ical.js reads a UTC instant's wall clock as local time, so within |offset| of a transition
      // it picks the other side's offset (spike q4 harness artefact). Anything else is a real error.
      const realErrors: string[] = [];
      for (let t = FROM; t < TO; t += SIX_HOURS) {
        const expected = intlOffsetMinutes(tz, t);
        const actual = icalOffsetMinutes(zone, t);
        if (expected === actual) continue;
        const [lo, hi] = [Math.min(t, t - expected * 60_000), Math.max(t, t - expected * 60_000)];
        const artefact = transitions.some((tr) => tr.at >= lo && tr.at <= hi && (actual === tr.from || actual === tr.to));
        if (!artefact) realErrors.push(`${new Date(t).toISOString()} intl=${expected} ical=${actual}`);
      }
      expect(realErrors).toEqual([]);
    }, 30_000);

  test("emits explicit transitions only, no RRULE", () => {
    const vtz = vtimezoneFor("America/New_York", { from: Temporal.Instant.from("2026-01-01T00:00:00Z"), to: Temporal.Instant.from("2027-01-01T00:00:00Z") });
    expect(subcomponents(vtz).map((o) => [o[0], ...["dtstart", "tzoffsetfrom", "tzoffsetto", "rrule"].map((n) => getProp(o, n)?.[3])])).toEqual([
      ["standard", "2025-12-31T19:00:00", "-05:00", "-05:00", undefined],
      ["daylight", "2026-03-08T02:00:00", "-05:00", "-04:00", undefined],
      ["standard", "2026-11-01T02:00:00", "-04:00", "-05:00", undefined],
    ]);
  });

  test("throws UnknownTimeZoneError for Mars/Olympus", () => {
    const range = { from: Temporal.Instant.from("2026-01-01T00:00:00Z"), to: Temporal.Instant.from("2027-01-01T00:00:00Z") };
    expect(() => vtimezoneFor("Mars/Olympus", range)).toThrow(UnknownTimeZoneError);
  });
});
