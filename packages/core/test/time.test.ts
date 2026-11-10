import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import { type EventResource, UnknownTimeZoneError, expandOccurrences, parseCalendar, serializeCalendar, spanOf, validateObject, MAX_ITERATIONS } from "../src/index.ts";

const tricky = parseCalendar(readFileSync(new URL("./fixtures/tricky.ics", import.meta.url), "utf8")).resources;
const byUid = (uid: string): EventResource => {
  const r = tricky.find((x) => x.uid === uid);
  if (!r) throw new Error(`missing ${uid}`);
  return r;
};

const window = (from: string, to: string) => ({ from: Temporal.Instant.from(from), to: Temporal.Instant.from(to) });
const ALL = window("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");

function resource(...vevent: string[]): EventResource {
  const [r] = parseCalendar(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:t@example.com", ...vevent, "END:VEVENT", "END:VCALENDAR"].join("\r\n")).resources;
  if (!r) throw new Error("no resource");
  return r;
}

const starts = (r: EventResource, w = ALL, zone?: string) => expandOccurrences(r, w, zone).occurrences.map((o) => o.start.toString());

describe('spanOf recurrence validation', () => {
  test('unbounded rules reject unreadable EXDATEs', () => {
    const data = resource('DTSTART:20261109T090000Z', 'RRULE:FREQ=DAILY', 'EXDATE;TZID=Unknown/Zone:20261110T090000');
    expect(() => spanOf(data)).toThrow(UnknownTimeZoneError);
    expect(validateObject(serializeCalendar({ props: [], resources: [data] }))).toMatchObject({ ok: false, code: 'invalid-calendar-data' });
  });

  test('unbounded rules reject malformed RDATEs', () => {
    const data = resource('DTSTART:20261109T090000Z', 'RRULE:FREQ=DAILY', 'RDATE:20261110T090000Z');
    const rdate = data.master?.[1].find((p) => p[0] === 'rdate');
    if (!rdate) throw new Error('no RDATE');
    rdate[3] = 'invalid';
    expect(() => spanOf(data)).toThrow(RangeError);
  });

  test('unbounded rules with readable recurrence values remain infinite', () => {
    expect(spanOf(resource('DTSTART:20261109T090000Z', 'RRULE:FREQ=DAILY', 'EXDATE;TZID=Europe/Paris:20261110T090000', 'RDATE:20261111T090000Z')).end).toBe('infinity');
  });
});

describe("expandOccurrences", () => {
  test("a weekly New York series crosses both 2026 DST transitions at the right UTC instants", () => {
    const r = resource("DTSTART;TZID=America/New_York:20260301T090000", "DTEND;TZID=America/New_York:20260301T100000", "RRULE:FREQ=WEEKLY");
    const w = window("2026-03-01T00:00:00Z", "2026-03-09T00:00:00Z");
    expect(starts(r, w)).toEqual(["2026-03-01T14:00:00Z", "2026-03-08T13:00:00Z"]);
    const fall = expandOccurrences(r, window("2026-10-25T00:00:00Z", "2026-11-02T00:00:00Z")).occurrences;
    expect(fall.map((o) => [o.start.toString(), o.end.toString()])).toEqual([
      ["2026-10-25T13:00:00Z", "2026-10-25T14:00:00Z"],
      ["2026-11-01T14:00:00Z", "2026-11-01T15:00:00Z"],
    ]);
    // 02:30 does not exist on 2026-03-08; 'compatible' moves it forward to 03:30 EDT.
    const gap = resource("DTSTART;TZID=America/New_York:20260307T023000", "RRULE:FREQ=DAILY;COUNT=2");
    expect(starts(gap)).toEqual(["2026-03-07T07:30:00Z", "2026-03-08T07:30:00Z"]);
  });

  // BC is on permanent UTC-7 from 2026-11 (tzdata 2026e). A runtime with older ICU data gives
  // 18:05Z here; the image sets ICU_TIMEZONE_FILES_DIR to newer data (see Dockerfile).
  test("America/Vancouver stays at UTC-7 after 2026-11-01", () => {
    const r = resource("DTSTART;TZID=America/Vancouver:20261111T100500", "DTEND;TZID=America/Vancouver:20261111T103500");
    expect(starts(r)).toEqual(["2026-11-11T17:05:00Z"]);
  });

  const weekly = byUid("weekly-sync@example.com");
  const nov =expandOccurrences(weekly, window("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")).occurrences;

  test("an EXDATE removes its instance", () => {
    expect(nov.map((o) => o.recurrenceId)).toEqual(["2026-11-02T09:00:00", "2026-11-09T09:00:00", "2026-11-30T09:00:00"]);
  });

  test("a moved override replaces its instance", () => {
    const moved = nov[1];
    expect(moved?.start.toString()).toBe("2026-11-09T16:00:00Z");
    expect(moved?.end.toString()).toBe("2026-11-09T16:30:00Z");
    expect(moved?.component).toBe(weekly.overrides[0]!);
  });

  test("THISANDFUTURE shifts every later instance, up to an inclusive UTC UNTIL", () => {
    const later = expandOccurrences(weekly, window("2026-12-28T00:00:00Z", "2027-04-01T00:00:00Z")).occurrences;
    expect(later.map((o) => o.start.toString())).toEqual([
      "2026-12-28T14:00:00Z",
      "2027-01-04T15:00:00Z",
      "2027-01-11T15:00:00Z",
      "2027-01-18T15:00:00Z",
      "2027-01-25T15:00:00Z",
      "2027-02-01T15:00:00Z",
      "2027-02-08T15:00:00Z",
      "2027-02-15T15:00:00Z",
      "2027-02-22T15:00:00Z",
      "2027-03-01T15:00:00Z",
    ]);
    expect(later.slice(1).every((o) => o.component === weekly.overrides[1])).toBe(true);
    expect(later[2]?.recurrenceId).toBe("2027-01-11T09:00:00");
  });

  test("an all-day event spans its local date in the calendar zone", () => {
    const [o] = expandOccurrences(byUid("allday@example.com"), ALL, "Europe/Berlin").occurrences;
    expect(o).toMatchObject({ recurrenceId: "2026-12-24", allDay: true });
    expect([o?.start.toString(), o?.end.toString()]).toEqual(["2026-12-23T23:00:00Z", "2026-12-26T23:00:00Z"]);
  });

  test("a floating daily event follows the supplied zone", () => {
    const floating = byUid("floating@example.com");
    expect(starts(floating, ALL, "America/Los_Angeles")).toEqual([5, 6, 7, 8, 9, 10].map((d) => `2026-11-${String(d).padStart(2, "0")}T15:00:00Z`));
    expect(starts(floating, ALL, "Asia/Tokyo")[0]).toBe("2026-11-04T22:00:00Z");
    expect(starts(floating)[0]).toBe("2026-11-05T07:00:00Z");
  });

  test("caps at the limit and reports truncation", () => {
    const r = resource("DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY");
    const { occurrences, truncated } = expandOccurrences(r, window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), "UTC", 10);
    expect([occurrences.length, truncated]).toEqual([10, true]);
  });

  test("an unknown TZID without a VTIMEZONE throws instead of falling back to UTC", () => {
    expect(() => expandOccurrences(resource("DTSTART;TZID=Mars/Olympus:20260101T090000"), ALL)).toThrow(UnknownTimeZoneError);
  });
});

describe("spanOf", () => {
  test("a bounded series ends at its last occurrence; an unbounded one at infinity", () => {
    const weekly = spanOf(byUid("weekly-sync@example.com"));
    expect([weekly.start.toString(), weekly.end.toString()]).toEqual(["2026-11-02T14:00:00Z", "2027-03-01T15:30:00Z"]);
    const flight = spanOf(byUid("flight@example.com"));
    expect([flight.start.toString(), flight.end.toString()]).toEqual(["2026-11-20T23:00:00Z", "2026-11-21T07:00:00Z"]);
    expect(spanOf(resource("DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY")).end).toBe("infinity");
  });
});


describe("object work budgets", () => {
  for (const suffix of [";COUNT=2", ""])
    test(`an impossible daily rule returns with truncation (${suffix || "unbounded"})`, () => {
      const started = performance.now();
      const r = resource("DTSTART:20260101T090000Z", `RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30${suffix}`);
      expect(expandOccurrences(r, ALL).truncated).toBe(true);
      expect(spanOf(r).end).toBe("infinity");
      expect(validateObject(serializeCalendar({ props: [], resources: [r] })).ok).toBe(true);
      expect(performance.now() - started).toBeLessThan(2000);
    }, 2000);

  test("a rarely matching secondly rule exhausts its steps across yielded values", () => {
    const started = performance.now();
    const r = resource("DTSTART:20260101T000000Z", "RRULE:FREQ=SECONDLY;BYHOUR=0;BYMINUTE=0;BYSECOND=0;COUNT=200000");
    expect(expandOccurrences(r, ALL).truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  }, 2000);

  for (const frequency of ["HOURLY", "DAILY"])
    test(`a huge ${frequency} interval is refused before stepping`, () => {
      const started = performance.now();
      const r = resource("DTSTART:20260101T090000Z", `RRULE:FREQ=${frequency};INTERVAL=1000000000000;COUNT=2`);
      expect(expandOccurrences(r, ALL)).toEqual({ occurrences: [], truncated: true });
      expect(spanOf(r).end).toBe("infinity");
      expect(performance.now() - started).toBeLessThan(2000);
    }, 2000);

  test("ordinary intervals still yield every value", () => {
    const r = resource("DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY;INTERVAL=7;COUNT=10");
    const result = expandOccurrences(r, ALL);
    expect(result.truncated).toBe(false);
    expect(result.occurrences).toHaveLength(10);
    expect(result.occurrences.at(-1)?.start.toString()).toBe("2026-03-05T09:00:00Z");
  });

  test("the occurrence cap makes a bounded series span infinite", () => {
    const started = performance.now();
    const r = resource("DTSTART:20260101T090000Z", `RRULE:FREQ=DAILY;COUNT=${MAX_ITERATIONS + 1}`);
    expect(spanOf(r).end).toBe("infinity");
    expect(performance.now() - started).toBeLessThan(2000);
  }, 2000);

  test("RDATE lookup for 8,000 dates is comparable to EXDATE lookup", () => {
    const dates = Array.from({ length: 8000 }, (_, n) => new Date(Date.UTC(2026, 0, n + 2, 9)).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z').join(',');
    const rdates = resource("DTSTART:20260101T090000Z", `RDATE:${dates}`);
    const exdates = resource("DTSTART:20260101T090000Z", `EXDATE:${dates}`);
    const started = performance.now();
    spanOf(exdates);
    const exdateMs = performance.now() - started;
    const rdateStarted = performance.now();
    expect(spanOf(rdates).end.toString()).toBe("2047-11-27T09:00:00Z");
    const rdateMs = performance.now() - rdateStarted;
    expect(rdateMs).toBeLessThan(exdateMs * 4 + 100);
    expect(performance.now() - started).toBeLessThan(2000);
  }, 2000);

  test("a repeated RDATE period updates the original base's length", () => {
    const r = resource("DTSTART:20260101T090000Z", "RDATE:20260102T090000Z", "RDATE;VALUE=PERIOD:20260102T090000Z/PT3H");
    const result = expandOccurrences(r, ALL);
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences[1]?.end.toString()).toBe("2026-01-02T12:00:00Z");
  });

  test("10,001 RDATE values or overrides exceed the object cap", () => {
    const r = resource("DTSTART:20260101T090000Z", `RDATE:${Array.from({ length: 10001 }, () => '20260102T090000Z').join(',')}`);
    expect(() => spanOf(r)).toThrow(RangeError);
    const single = resource("DTSTART:20260101T090000Z");
    expect(() => spanOf({ ...single, overrides: Array.from({ length: 10001 }, () => single.master!) })).toThrow(RangeError);
  });
});
