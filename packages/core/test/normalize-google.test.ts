import { describe, expect, test } from "bun:test";
import { attendees, classification, getProp, getProps, normalizeGoogle, propParam, recurrenceId, serializeCalendar, summary, textValue, type GoogleEvent } from "../src/index.ts";
import { allDay, movedInstance, sparseCancelled, weeklyMaster } from "./fixtures/google.ts";

const normalize = (uid: string, ...events: GoogleEvent[]) =>
  normalizeGoogle(events.map((e) => ({ id: e.id, etag: `"${e.id}"`, groupUid: uid, payload: JSON.stringify(e) })));

const resourceOf = (uid: string, ...events: GoogleEvent[]) => {
  const result = normalize(uid, ...events);
  if (!result) throw new Error("expected a resource");
  expect(result.completeness).toBe("complete");
  return result.resource;
};

const icsOf = (uid: string, ...events: GoogleEvent[]) => serializeCalendar({ props: [], resources: [resourceOf(uid, ...events)] });

describe("normalizeGoogle", () => {
  test("a weekly master, a moved instance and a sparse cancelled one share the master's UID and zone", () => {
    const resource = resourceOf("series@example.test", weeklyMaster, movedInstance, sparseCancelled);
    const ics = serializeCalendar({ props: [], resources: [resource] });
    expect(resource.master && summary(resource.master)).toBe(weeklyMaster.summary ?? null);
    expect(resource.overrides.map((o) => summary(o))).toEqual(["Moved"]);
    expect(ics).toContain("DTSTART;TZID=America/Los_Angeles:20261026T090000");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;COUNT=5");
    // The RECURRENCE-ID and EXDATE are in the master's zone, so there is no drift across DST.
    expect(ics).toContain("RECURRENCE-ID;TZID=America/Los_Angeles:20261102T090000");
    expect(ics).toContain("DTSTART;TZID=America/Los_Angeles:20261102T110000");
    expect(ics).toContain("EXDATE;TZID=America/Los_Angeles:20261109T090000");
    expect(Object.keys(resource.timezones)).toEqual(["America/Los_Angeles"]);
    expect(ics).toContain("BEGIN:VTIMEZONE");
  });

  test("all-day events keep VALUE=DATE and Google's exclusive end", () => {
    const ics = icsOf("day@example.test", allDay);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261110");
    expect(ics).toContain("DTEND;VALUE=DATE:20261112");
    expect(ics).not.toContain("VTIMEZONE");
  });

  test("conferenceData's video entry point becomes CONFERENCE and URL", () => {
    const master = resourceOf("series@example.test", weeklyMaster).master;
    if (!master) throw new Error("no master");
    const conference = getProp(master, "conference");
    expect(conference?.[3]).toBe("https://meet.google.com/abc-defg-hij");
    expect(conference && propParam(conference, "feature")).toBe("VIDEO");
    expect(textValue(master, "url")).toBe("https://meet.google.com/abc-defg-hij");
  });

  test("HTML descriptions stay in DESCRIPTION and are also sent as X-ALT-DESC", () => {
    const html = '<p>Agenda: <a href="https://example.test">doc</a></p>';
    const master = resourceOf("h@test", { ...allDay, id: "h", description: html }).master;
    if (!master) throw new Error("no master");
    expect(textValue(master, "description")).toBe(html);
    const alt = getProp(master, "x-alt-desc");
    expect(alt?.[3]).toBe(html);
    expect(alt && propParam(alt, "fmttype")).toBe("text/html");
    const plain = resourceOf("p@test", { ...allDay, id: "p", description: "a < b, and c > d" }).master;
    expect(plain && getProp(plain, "x-alt-desc")).toBeUndefined();
  });

  test("organizer and attendees map with PARTSTAT from responseStatus", () => {
    const master = resourceOf("m@test", {
      ...allDay,
      id: "m",
      organizer: { email: "boss@example.test", displayName: 'The "Boss"' },
      attendees: [
        { email: "a@example.test", responseStatus: "accepted" },
        { email: "d@example.test", responseStatus: "declined" },
        { email: "t@example.test", responseStatus: "tentative", optional: true },
        { email: "n@example.test", responseStatus: "needsAction" },
        { email: "room@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
      ],
    }).master;
    if (!master) throw new Error("no master");
    const organizer = getProp(master, "organizer");
    expect(organizer?.[3]).toBe("mailto:boss@example.test");
    expect(organizer && propParam(organizer, "cn")).toBe("The Boss");
    expect(attendees(master).map((a) => [a.address, a.params.partstat])).toEqual([
      ["mailto:a@example.test", "ACCEPTED"],
      ["mailto:d@example.test", "DECLINED"],
      ["mailto:t@example.test", "TENTATIVE"],
      ["mailto:n@example.test", "NEEDS-ACTION"],
      ["mailto:room@resource.calendar.google.com", "ACCEPTED"],
    ]);
    expect(getProps(master, "attendee").map((p) => propParam(p, "role"))).toContain("OPT-PARTICIPANT");
  });

  test("private visibility sets CLASS:PRIVATE; transparency and status carry over", () => {
    const master = resourceOf("v@test", { ...allDay, id: "v", visibility: "private", transparency: "transparent", status: "tentative", sequence: 3 }).master;
    if (!master) throw new Error("no master");
    expect(classification(master)).toBe("PRIVATE");
    expect(textValue(master, "transp")).toBe("TRANSPARENT");
    expect(textValue(master, "status")).toBe("TENTATIVE");
    expect(getProp(master, "sequence")?.[3]).toBe(3);
  });

  test("outOfOffice maps as an ordinary busy event; workingLocation and birthday publish nothing", () => {
    const ooo = resourceOf("o@test", { ...allDay, id: "o", eventType: "outOfOffice", summary: "Away" }).master;
    expect(ooo && summary(ooo)).toBe("Away");
    expect(normalize("w@test", { ...allDay, id: "w", eventType: "workingLocation" })).toBeNull();
    expect(normalize("b@test", { ...allDay, id: "b", eventType: "birthday" })).toBeNull();
  });

  test("a cancelled master, or only cancelled instances left, publishes nothing", () => {
    expect(normalize("series@example.test", { ...weeklyMaster, status: "cancelled" }, movedInstance)).toBeNull();
    expect(normalize("series@example.test", sparseCancelled)).toBeNull();
    // A moved instance without its master stays visible on its own.
    const orphan = resourceOf("series@example.test", movedInstance);
    expect(orphan.master).toBeNull();
    expect(orphan.overrides.map(recurrenceId)).toHaveLength(1);
  });

  test("text is escaped and recurrence lines are validated", () => {
    expect(icsOf("series@example.test", weeklyMaster)).toContain("SUMMARY:Weekly\\; team\\, sync\\nNew line");
    expect(() => normalize("x@test", { ...weeklyMaster, recurrence: ["RRULE:FREQ=DAILY\r\nATTENDEE:mailto:x@evil.test"] })).toThrow();
  });
});
