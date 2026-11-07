import { describe, expect, test } from "bun:test";
import {
  type EventResource,
  type JCalParams,
  type SourceObject,
  groupUidsOf,
  normalizeIcal,
  revisionOf,
  sequence,
  summary,
} from "../src/index.ts";

const object = (id: string, seq: number, title: string): SourceObject => ({
  id,
  etag: `"${id}"`,
  groupUid: "u@example.com",
  payload: [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:u@example.com",
    "RECURRENCE-ID:20261109T140000Z",
    `SEQUENCE:${seq}`,
    "DTSTART:20261109T160000Z",
    `SUMMARY:${title}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"),
});

describe("normalizeIcal", () => {
  test("two objects with the same UID and RECURRENCE-ID: the higher SEQUENCE wins", () => {
    const { resource, completeness } = normalizeIcal([object("a", 2, "newer"), object("b", 1, "older")]);
    expect(completeness).toBe("complete");
    expect(resource.master).toBeNull();
    expect(resource.overrides.map((c) => [summary(c), sequence(c)])).toEqual([["newer", 2]]);
    // A tie falls back to the lower object id, whatever the input order.
    const tie = normalizeIcal([object("z", 1, "from z"), object("m", 1, "from m")]);
    expect(tie.resource.overrides.map(summary)).toEqual(["from m"]);
  });

  test("groupUidsOf lists the UIDs of a payload", () => {
    expect(groupUidsOf(object("a", 0, "x").payload)).toEqual(["u@example.com"]);
  });
});

describe("revisionOf", () => {
  const withAttendee = (params: JCalParams): EventResource => ({
    uid: "u",
    master: ["vevent", [["attendee", params, "cal-address", "mailto:a@example.com"]], []],
    overrides: [],
    timezones: {},
  });

  test("ignores parameter order but not values", () => {
    const a = revisionOf(withAttendee({ cn: "A", role: "CHAIR" }));
    expect(revisionOf(withAttendee({ role: "CHAIR", cn: "A" }))).toBe(a);
    expect(revisionOf(withAttendee({ role: "CHAIR", cn: "B" }))).not.toBe(a);
  });
});
