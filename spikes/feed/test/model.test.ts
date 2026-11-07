import { expect, test } from "bun:test";
import ICAL from "ical.js";
import { mergeCopies, renderObject, resourcesFromIcs, type EventResource } from "../src/model";

const tricky = await Bun.file(new URL("../fixtures/tricky.ics", import.meta.url)).text();
const res = resourcesFromIcs(tricky);
const byUid = (uid: string) => {
  const r = res.find((x) => x.uid === uid);
  if (!r) throw new Error(uid);
  return r;
};
const props = (ics: string) => new Set(ics.replace(/\r\n[ \t]/g, "").split("\r\n").map((l) => l.split(/[;:]/)[0]));

test("resources group master + overrides by UID and keep their VTIMEZONEs", () => {
  const weekly = byUid("weekly-sync@example.com");
  expect(weekly.overrides).toHaveLength(2);
  expect(Object.keys(weekly.timezones)).toEqual(["America/New_York"]);
  expect(Object.keys(byUid("flight@example.com").timezones).sort()).toEqual(["America/New_York", "Europe/Berlin"]);
});

test("full: everything kept except VALARM (default), unknown props intact", () => {
  const out = renderObject(byUid("weekly-sync@example.com"), { privacy: "full", keepAlarms: false, outUid: "weekly-sync@example.com" }) ?? "";
  for (const p of ["X-GOOGLE-CONFERENCE", "X-APPLE-STRUCTURED-LOCATION", "CONFERENCE", "COLOR", "ATTENDEE", "EXDATE", "RECURRENCE-ID"]) expect(props(out).has(p)).toBe(true);
  expect(out).not.toContain("BEGIN:VALARM");
  expect(out).toContain("RANGE=THISANDFUTURE");
  const kept = renderObject(byUid("weekly-sync@example.com"), { privacy: "full", keepAlarms: true, outUid: "x" }) ?? "";
  expect(kept).toContain("BEGIN:VALARM");
});

test("busy-only: allowlist, SUMMARY=Busy, recurrence structure kept", () => {
  const out = renderObject(byUid("weekly-sync@example.com"), { privacy: "busy-only", keepAlarms: true, outUid: "h@supercal" }) ?? "";
  for (const p of ["DESCRIPTION", "LOCATION", "ATTENDEE", "ORGANIZER", "CONFERENCE", "X-GOOGLE-CONFERENCE", "X-MICROSOFT-CDO-BUSYSTATUS", "X-APPLE-STRUCTURED-LOCATION", "COLOR"]) expect(props(out).has(p)).toBe(false);
  expect(out).not.toContain("VALARM");
  expect(out.match(/SUMMARY:Busy/g)).toHaveLength(3); // master + 2 overrides, override titles do not leak
  for (const p of ["RRULE", "EXDATE", "RECURRENCE-ID"]) expect(props(out).has(p)).toBe(true);
  expect(out).toContain("UID:h@supercal");
  expect(out).not.toContain("weekly-sync@example.com");
});

test("busy-only drops TRANSP:TRANSPARENT (free) events", () => {
  expect(renderObject(byUid("allday@example.com"), { privacy: "busy-only", keepAlarms: false, outUid: "x" })).toBeNull();
});

test("title-only keeps SUMMARY, strips details; CLASS:PRIVATE degrades to Busy", () => {
  const out = renderObject(byUid("weekly-sync@example.com"), { privacy: "title-only", keepAlarms: false, outUid: "x" }) ?? "";
  expect(out).toContain("SUMMARY:Weekly sync");
  expect(props(out).has("LOCATION")).toBe(false);
  expect(props(out).has("ATTENDEE")).toBe(false);
  const priv = renderObject(byUid("flight@example.com"), { privacy: "title-only", keepAlarms: false, outUid: "x" }) ?? "";
  expect(priv).toContain("SUMMARY:Busy");
  expect(priv).not.toContain("Flight");
});

const copy = (uid: string, seq: number, organizer: string, summary: string, stamp: string, rid?: string): EventResource =>
  resourcesFromIcs(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${stamp}\r\nSEQUENCE:${seq}\r\n${rid ? `RECURRENCE-ID:${rid}\r\n` : ""}DTSTART:20261110T100000Z\r\nDTEND:20261110T110000Z\r\nORGANIZER:mailto:${organizer}\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0]!;
const summaryOf = (r: EventResource) => (r.master ? new ICAL.Component(r.master).getFirstPropertyValue("summary") : null);

test("merge: organizer's copy wins over higher SEQUENCE", () => {
  const m = mergeCopies([
    { r: copy("m", 5, "org@x", "attendee copy", "20261102T000000Z"), ownerEmail: "me@x", priority: 0 },
    { r: copy("m", 1, "org@x", "organizer copy", "20261101T000000Z"), ownerEmail: "org@x", priority: 1 },
  ]);
  expect(summaryOf(m)).toBe("organizer copy");
});

test("merge: otherwise SEQUENCE, then LAST-MODIFIED/DTSTAMP, then priority", () => {
  const a = copy("m", 2, "boss@x", "seq2 old", "20261101T000000Z");
  const b = copy("m", 2, "boss@x", "seq2 new", "20261103T000000Z");
  const c = copy("m", 1, "boss@x", "seq1 newest", "20261109T000000Z");
  expect(summaryOf(mergeCopies([a, b, c].map((r, i) => ({ r, ownerEmail: "me@x", priority: i }))))).toBe("seq2 new");
});

test("merge: overrides unioned per RECURRENCE-ID (attendee invited to one instance only)", () => {
  const series = copy("s", 1, "org@x", "series", "20261101T000000Z");
  const lone = copy("s", 1, "org@x", "single instance", "20261101T000000Z", "20261117T100000Z");
  lone.master = null;
  const m = mergeCopies([{ r: series, ownerEmail: null, priority: 0 }, { r: lone.overrides.length ? lone : { ...lone, overrides: [] }, ownerEmail: null, priority: 1 }]);
  expect(m.master).not.toBeNull();
  expect(m.overrides).toHaveLength(1);
});
