import { describe, expect, test } from "bun:test";
import ICAL from "ical.js";
import {
  CANCELLED_ANNOTATION,
  graphRrule,
  ianaZone,
  normalizeGraph,
  serializeCalendar,
  summary,
  UnknownTimeZoneError,
  UNRESOLVED_CANCELLATION,
  UnsupportedRecurrenceError,
  type GraphEvent,
  type GraphRecurrence,
} from "../src/index.ts";
import { movedException, tokyoDay, weeklyMaster } from "./fixtures/graph.ts";

const normalize = (uid: string, ...events: GraphEvent[]) =>
  normalizeGraph(events.map((e) => ({ id: e.id, etag: `"${e.id}"`, groupUid: uid, payload: JSON.stringify(e) })));

function icsOf(uid: string, ...events: GraphEvent[]) {
  const result = normalize(uid, ...events);
  if (!result) throw new Error("expected a resource");
  // Unfolded, so long lines can be matched whole.
  return { ics: serializeCalendar({ props: [], resources: [result.resource] }).replace(/\r\n /g, ""), ...result };
}

const resolved = { ...weeklyMaster, [CANCELLED_ANNOTATION]: [{ id: "opaque-cancelled-id", originalStart: "2026-11-09T17:00:00Z" }] };
const LA = { zone: "America/Los_Angeles", allDay: false };
const numbered = (pattern: GraphRecurrence["pattern"], startDate: string): GraphRecurrence => ({ pattern, range: { type: "numbered", startDate, numberOfOccurrences: 5 } });

describe("graphRrule", () => {
  const patterns: { pattern: GraphRecurrence["pattern"]; startDate: string; expected: string }[] = [
    { pattern: { type: "daily", interval: 2 }, startDate: "2026-11-01", expected: "FREQ=DAILY;INTERVAL=2" },
    { pattern: { type: "weekly", interval: 2, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "monday" }, startDate: "2026-11-02", expected: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO" },
    { pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 15 }, startDate: "2026-11-15", expected: "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15" },
    { pattern: { type: "relativeMonthly", interval: 1, daysOfWeek: ["thursday"], index: "second" }, startDate: "2026-11-12", expected: "FREQ=MONTHLY;INTERVAL=1;BYDAY=TH;BYSETPOS=2" },
    { pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 15, month: 3 }, startDate: "2027-03-15", expected: "FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=15" },
    { pattern: { type: "relativeYearly", interval: 1, month: 11, daysOfWeek: ["friday"], index: "last" }, startDate: "2026-11-27", expected: "FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=FR;BYSETPOS=-1" },
  ];
  for (const { pattern, startDate, expected } of patterns)
    test(`${pattern.type} with a numbered range`, () => expect(graphRrule(numbered(pattern, startDate), { zone: "UTC", allDay: false })).toBe(`${expected};COUNT=5`));

  test("noEnd has neither COUNT nor UNTIL", () => {
    expect(graphRrule({ pattern: { type: "daily", interval: 1 }, range: { type: "noEnd", startDate: "2026-11-01" } }, LA)).toBe("FREQ=DAILY;INTERVAL=1");
  });

  test("an inclusive endDate is a UTC UNTIL at the end of the last local day, after DST; all-day stays a DATE", () => {
    const recurrence: GraphRecurrence = { pattern: { type: "daily", interval: 1 }, range: { type: "endDate", startDate: "2026-10-30", endDate: "2026-11-02" } };
    expect(graphRrule(recurrence, LA)).toBe("FREQ=DAILY;INTERVAL=1;UNTIL=20261103T075959Z");
    expect(graphRrule(recurrence, { ...LA, allDay: true })).toBe("FREQ=DAILY;INTERVAL=1;UNTIL=20261102");
  });

  test("relative monthly expands to the second Thursday, including short months", () => {
    const rule = ICAL.Recur.fromString(graphRrule({ ...numbered({ type: "relativeMonthly", interval: 1, daysOfWeek: ["thursday"], index: "second" }, "2026-01-08"), range: { type: "numbered", startDate: "2026-01-08", numberOfOccurrences: 3 } }, { zone: "UTC", allDay: false }));
    const iterator = rule.iterator(ICAL.Time.fromDateTimeString("2026-01-08T09:00:00Z"));
    expect([iterator.next()?.toString(), iterator.next()?.toString(), iterator.next()?.toString()]).toEqual(["2026-01-08T09:00:00Z", "2026-02-12T09:00:00Z", "2026-03-12T09:00:00Z"]);
    expect(iterator.next()).toBeNull();
  });

  test("unverified shapes are rejected, not approximated", () => {
    const several = numbered({ type: "relativeMonthly", interval: 1, daysOfWeek: ["monday", "friday"], index: "first" }, "2026-11-02");
    expect(() => graphRrule(several, LA)).toThrow(UnsupportedRecurrenceError);
    // Weekly on Wednesdays, but the range starts on a Monday.
    const offset = numbered({ type: "weekly", interval: 1, daysOfWeek: ["wednesday"] }, "2026-11-02");
    expect(() => graphRrule(offset, LA)).toThrow(UnsupportedRecurrenceError);
  });
});

describe("normalizeGraph", () => {
  test("a Windows-zoned series with a moved exception and an indexed cancellation uses the master's UID and zone", () => {
    const { ics, resource, completeness } = icsOf("master@example.test", resolved, movedException);
    expect(completeness).toBe("complete");
    expect(resource.overrides.map((o) => summary(o))).toEqual(["Moved"]);
    expect(ics).toContain("DTSTART;TZID=America/Los_Angeles:20261026T090000");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;WKST=SU;COUNT=5");
    // RECURRENCE-ID and EXDATE are in the series zone, so they do not drift across DST.
    expect(ics).toContain("RECURRENCE-ID;TZID=America/Los_Angeles:20261102T090000");
    expect(ics).toContain("DTSTART;TZID=America/Los_Angeles:20261102T110000");
    expect(ics).toContain("EXDATE;TZID=America/Los_Angeles:20261109T090000");
    expect(ics).not.toContain("DIFFERENT-UID");
    expect(ics).toContain("CONFERENCE;FEATURE=VIDEO;VALUE=URI:https://teams.microsoft.com/l/meetup-join/fixture");
    expect(ics).toContain("URL:https://teams.microsoft.com/l/meetup-join/fixture");
    expect(Object.keys(resource.timezones)).toEqual(["America/Los_Angeles"]);
  });

  test("an unresolved cancellation still publishes the master, marked incomplete", () => {
    const unresolved = { ...weeklyMaster, [CANCELLED_ANNOTATION]: [{ id: "opaque-cancelled-id", originalStart: null }] };
    for (const master of [unresolved, weeklyMaster]) {
      const { ics, resource, completeness } = icsOf("master@example.test", master);
      expect(resource.master).not.toBeNull();
      expect(ics).toContain("RRULE:");
      expect(ics).not.toContain("EXDATE");
      expect(completeness).toEqual({ incomplete: expect.stringMatching(new RegExp(`^${UNRESOLVED_CANCELLATION}`)) });
    }
  });

  test("all-day events keep their dates; a UTC response is converted back to Tokyo's date", () => {
    const pacific: GraphEvent = { id: "day", iCalUId: "day@example.test", isAllDay: true, start: { dateTime: "2026-11-10T00:00:00", timeZone: "Pacific Standard Time" }, end: { dateTime: "2026-11-11T00:00:00", timeZone: "Pacific Standard Time" } };
    const day = icsOf("day@example.test", pacific).ics;
    expect(day).toContain("DTSTART;VALUE=DATE:20261110");
    expect(day).toContain("DTEND;VALUE=DATE:20261111");
    const tokyo = icsOf("tokyo@example.test", tokyoDay).ics;
    expect(tokyo).toContain("DTSTART;VALUE=DATE:20261110");
    expect(tokyo).toContain("DTEND;VALUE=DATE:20261111");
    expect(tokyo).not.toContain("VTIMEZONE");
  });

  test("Windows zones map through CLDR territory 001; a custom zone is an error, never UTC", () => {
    expect(ianaZone("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(ianaZone("Tokyo Standard Time")).toBe("Asia/Tokyo");
    expect(ianaZone("Europe/Paris")).toBe("Europe/Paris");
    expect(ianaZone("UTC")).toBe("UTC");
    expect(() => ianaZone("tzone://Microsoft/Custom")).toThrow(UnknownTimeZoneError);
    expect(() => normalize("master@example.test", { ...weeklyMaster, originalStartTimeZone: "Customized Time Zone", recurrence: null })).toThrow(UnknownTimeZoneError);
  });

  test("rejected recurrence shapes fail the group rather than publishing an approximation", () => {
    const multi = { ...weeklyMaster, recurrence: { ...numbered({ type: "relativeMonthly", interval: 1, daysOfWeek: ["monday", "tuesday"], index: "last" }, "2026-10-26"), range: { type: "noEnd", startDate: "2026-10-26" } } } satisfies GraphEvent;
    expect(() => normalize("master@example.test", multi)).toThrow(UnsupportedRecurrenceError);
    const lateStart = { ...weeklyMaster, recurrence: { ...weeklyMaster.recurrence!, range: { type: "noEnd", startDate: "2026-10-19" } } } satisfies GraphEvent;
    expect(() => normalize("master@example.test", lateStart)).toThrow(/not on its range startDate/);
  });

  test("status, transparency, class, people and an HTML body", () => {
    const meeting: GraphEvent = {
      id: "single",
      iCalUId: "single@example.test",
      originalStartTimeZone: "W. Europe Standard Time",
      start: { dateTime: "2026-11-10T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-10T10:00:00.0000000", timeZone: "UTC" },
      subject: "Review",
      isCancelled: true,
      showAs: "free",
      sensitivity: "private",
      location: { displayName: "Room 1" },
      body: { contentType: "html", content: "<html><head><style>p{}</style></head><body><p>Agenda &amp; notes</p><p>Line&nbsp;2</p></body></html>" },
      organizer: { emailAddress: { name: "Olga", address: "olga@example.test" } },
      attendees: [
        { type: "required", status: { response: "accepted" }, emailAddress: { name: "Ann", address: "ann@example.test" } },
        { type: "optional", status: { response: "tentativelyAccepted" }, emailAddress: { address: "bo@example.test" } },
        { type: "resource", status: { response: "none" }, emailAddress: { name: "Room 1", address: "room1@example.test" } },
      ],
    };
    const { ics } = icsOf("single@example.test", meeting);
    expect(ics).toContain("DTSTART;TZID=Europe/Berlin:20261110T100000");
    for (const line of ["STATUS:CANCELLED", "TRANSP:TRANSPARENT", "CLASS:PRIVATE", "SUMMARY:Review", "LOCATION:Room 1", "DESCRIPTION:Agenda & notes\\nLine 2", "X-ALT-DESC;FMTTYPE=text/html:"])
      expect(ics).toContain(line);
    expect(ics).toContain('ORGANIZER;CN=Olga:mailto:olga@example.test');
    expect(ics).toContain('ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ann@example.test');
    expect(ics).toContain("ATTENDEE;PARTSTAT=TENTATIVE;ROLE=OPT-PARTICIPANT:mailto:bo@example.test");
    expect(ics).toContain('ATTENDEE;CN=Room 1;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;CUTYPE=RESOURCE:mailto:room1@example.test');
  });

  test("exceptions without their master publish nothing", () => {
    expect(normalize("master@example.test", movedException)).toBeNull();
  });
});
