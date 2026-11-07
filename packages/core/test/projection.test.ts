import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import {
  BUSY_DTSTAMP,
  expandOccurrences,
  hrefFor,
  objectEtag,
  parseCalendar,
  project,
  projectCombined,
  serializeCalendar,
  summary,
  textValue,
  type EventResource,
  type PublicationSpec,
  type SourceResource,
} from "../src/index.ts";

const SECRET = new TextEncoder().encode("test uid secret");
const uidSecret = await crypto.subtle.importKey("raw", SECRET, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

const spec = (over: Partial<PublicationSpec> = {}): PublicationSpec => ({
  id: "pub_test",
  kind: "passthrough",
  privacy: "full",
  filters: { hideDeclined: false, hideCancelled: false, hideAllDay: false },
  keepAlarms: false,
  ownerAddresses: ["mailto:me@example.com"],
  uidSecret,
  ...over,
});
const filters = (over: Partial<PublicationSpec["filters"]>) => ({ ...spec().filters, ...over });

// Inputs are deep-frozen, so any mutation by the projection throws.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const source = (resources: EventResource[], over: Partial<Omit<SourceResource, "resource">> = {}): SourceResource[] =>
  resources.map((resource) => deepFreeze({ sourceCalendarId: "cal_1", priority: 0, ownerAddresses: [], ...over, resource }));

const parse = (ics: string) => {
  const parsed = parseCalendar(ics);
  expect(parsed.errors).toEqual([]);
  return parsed.resources;
};
const calendar = (...events: string[][]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

const tricky = parse(readFileSync(new URL("./fixtures/tricky.ics", import.meta.url), "utf8"));
const byUid = (uid: string) => {
  const r = tricky.find((x) => x.uid === uid);
  if (!r) throw new Error(uid);
  return r;
};

const render = (resources: EventResource[]) => serializeCalendar({ props: [], resources });
const projectText = async (s: PublicationSpec, inputs: SourceResource[]) => render((await project(s, inputs)).map((o) => o.resource));
const lines = (ics: string) => ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter(Boolean);
const names = (ics: string) => new Set(lines(ics).map((l) => l.split(/[;:]/)[0]));

describe("ported from the feed spike", () => {
  test("keeps master, overrides and the VTIMEZONEs they reference", async () => {
    const [weekly] = await project(spec(), source([byUid("weekly-sync@example.com")]));
    expect(weekly?.resource.overrides).toHaveLength(2);
    expect(Object.keys(weekly?.resource.timezones ?? {})).toEqual(["America/New_York"]);
    const [flight] = await project(spec(), source([byUid("flight@example.com")]));
    expect(Object.keys(flight?.resource.timezones ?? {}).sort()).toEqual(["America/New_York", "Europe/Berlin"]);
  });

  test("full: everything kept except VALARM (default), unknown props intact", async () => {
    const out = await projectText(spec(), source([byUid("weekly-sync@example.com")]));
    for (const p of ["X-GOOGLE-CONFERENCE", "X-APPLE-STRUCTURED-LOCATION", "CONFERENCE", "COLOR", "ATTENDEE", "EXDATE", "RECURRENCE-ID"])
      expect(names(out).has(p)).toBe(true);
    expect(out).not.toContain("BEGIN:VALARM");
    expect(out).toContain("RANGE=THISANDFUTURE");
    expect(await projectText(spec({ keepAlarms: true }), source([byUid("weekly-sync@example.com")]))).toContain("BEGIN:VALARM");
    expect(await projectText(spec(), source([byUid("flight@example.com")]))).toContain("CLASS:PRIVATE");
  });

  test("busy-only: allowlist, SUMMARY=Busy, recurrence structure kept", async () => {
    const out = await projectText(spec({ privacy: "busy-only", keepAlarms: true }), source([byUid("weekly-sync@example.com")]));
    for (const p of ["DESCRIPTION", "LOCATION", "ATTENDEE", "ORGANIZER", "CONFERENCE", "X-GOOGLE-CONFERENCE", "X-MICROSOFT-CDO-BUSYSTATUS", "X-APPLE-STRUCTURED-LOCATION", "COLOR"])
      expect(names(out).has(p)).toBe(false);
    expect(out).not.toContain("VALARM");
    expect(out.match(/SUMMARY:Busy/g)).toHaveLength(3); // master + 2 overrides: override titles do not leak
    for (const p of ["RRULE", "EXDATE", "RECURRENCE-ID"]) expect(names(out).has(p)).toBe(true);
    expect(out).toMatch(/^UID:[\w-]{26}@supercal$/m);
    expect(out).not.toContain("weekly-sync@example.com");
  });

  test("busy-only drops TRANSP:TRANSPARENT (free) events", async () => {
    expect(await project(spec({ privacy: "busy-only" }), source([byUid("allday@example.com")]))).toEqual([]);
  });

  test("title-only keeps SUMMARY, strips details; CLASS:PRIVATE degrades to Busy", async () => {
    const out = await projectText(spec({ privacy: "title-only" }), source([byUid("weekly-sync@example.com")]));
    expect(out).toContain("SUMMARY:Weekly sync\\, team\\; all hands");
    expect(out).toContain("COLOR:teal");
    expect(names(out).has("LOCATION")).toBe(false);
    expect(names(out).has("ATTENDEE")).toBe(false);
    const priv = await projectText(spec({ privacy: "title-only" }), source([byUid("flight@example.com")]));
    expect(priv).toContain("SUMMARY:Busy");
    expect(priv).not.toContain("Flight");
  });
});

describe("merge (virtual publications)", () => {
  const virtual = spec({ kind: "virtual" });
  const copy = (seq: number, organizer: string, title: string, stamp: string, rid?: string) =>
    parse(
      calendar([
        "UID:m@example.com",
        `DTSTAMP:${stamp}`,
        `SEQUENCE:${seq}`,
        ...(rid ? [`RECURRENCE-ID:${rid}`] : []),
        "DTSTART:20261110T100000Z",
        "DTEND:20261110T110000Z",
        `ORGANIZER:mailto:${organizer}`,
        `SUMMARY:${title}`,
      ]),
    );
  const merged = async (inputs: SourceResource[]) => {
    const [only, ...rest] = await project(virtual, inputs);
    expect(rest).toEqual([]);
    if (!only) throw new Error("nothing projected");
    return only.resource;
  };
  const title = (c: EventResource["master"]) => (c ? summary(c) : null);

  test("organizer's copy wins over higher SEQUENCE", async () => {
    const m = await merged([
      ...source(copy(5, "org@x", "attendee copy", "20261102T000000Z"), { sourceCalendarId: "a", ownerAddresses: ["mailto:me@x"] }),
      ...source(copy(1, "org@x", "organizer copy", "20261101T000000Z"), { sourceCalendarId: "b", ownerAddresses: ["mailto:org@x"], priority: 1 }),
    ]);
    expect(title(m.master)).toBe("organizer copy");
  });

  test("otherwise SEQUENCE, then LAST-MODIFIED/DTSTAMP, then priority", async () => {
    const a = copy(2, "boss@x", "seq2 old", "20261101T000000Z");
    const b = copy(2, "boss@x", "seq2 new", "20261103T000000Z");
    const c = copy(1, "boss@x", "seq1 newest", "20261109T000000Z");
    const inputs = [a, b, c].flatMap((r, i) => source(r, { sourceCalendarId: `cal_${i}`, priority: i, ownerAddresses: ["mailto:me@x"] }));
    expect(title((await merged(inputs)).master)).toBe("seq2 new");
    const tie = [a, a].map((r, i) => parse(render(r).replace("seq2 old", `priority ${i}`)));
    const tied = tie.flatMap((r, i) => source(r, { sourceCalendarId: `cal_${i}`, priority: 1 - i }));
    expect(title((await merged(tied)).master)).toBe("priority 1");
  });

  test("overrides unioned per RECURRENCE-ID (attendee invited to one instance only)", async () => {
    const m = await merged([
      ...source(copy(1, "org@x", "series", "20261101T000000Z"), { sourceCalendarId: "a" }),
      ...source(copy(1, "org@x", "single instance", "20261101T000000Z", "20261117T100000Z"), { sourceCalendarId: "b" }),
    ]);
    expect(title(m.master)).toBe("series");
    expect(m.overrides.map(title)).toEqual(["single instance"]);
  });

  test("winner is chosen per component", async () => {
    const x = parse(calendar(
      ["UID:m@example.com", "DTSTAMP:20261101T000000Z", "SEQUENCE:2", "DTSTART:20261103T100000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:x master"],
      ["UID:m@example.com", "DTSTAMP:20261101T000000Z", "SEQUENCE:1", "RECURRENCE-ID:20261110T100000Z", "DTSTART:20261110T120000Z", "SUMMARY:x override"],
    ));
    const y = parse(calendar(
      ["UID:m@example.com", "DTSTAMP:20261101T000000Z", "SEQUENCE:1", "DTSTART:20261103T100000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:y master"],
      ["UID:m@example.com", "DTSTAMP:20261101T000000Z", "SEQUENCE:3", "RECURRENCE-ID:20261110T100000Z", "DTSTART:20261110T130000Z", "SUMMARY:y override"],
    ));
    const m = await merged([...source(x, { sourceCalendarId: "x" }), ...source(y, { sourceCalendarId: "y" })]);
    expect([title(m.master), ...m.overrides.map(title)]).toEqual(["x master", "y override"]);
  });

  test("spike meetings A and B: organizer copy beats a higher SEQUENCE, else the newest SEQUENCE wins", async () => {
    const shared = (uid: string, seq: number, organizer: string, title: string, stamp: string) => [
      `UID:${uid}`, `DTSTAMP:${stamp}`, `SEQUENCE:${seq}`, "DTSTART;TZID=Europe/Berlin:20261110T140000", "DTEND;TZID=Europe/Berlin:20261110T150000",
      `SUMMARY:${title}`, `ORGANIZER:mailto:${organizer}`, "ATTENDEE;PARTSTAT=ACCEPTED:mailto:juan@work.example",
    ];
    const work = source(parse(calendar(
      shared("meeting-a@example.com", 1, "juan@work.example", "Meeting A (organizer copy)", "20261101T100000Z"),
      shared("meeting-b@example.com", 1, "boss@corp.example", "Meeting B (stale copy)", "20261101T100000Z"),
    )), { sourceCalendarId: "work", ownerAddresses: ["mailto:juan@work.example"] });
    const team = source(parse(calendar(
      shared("meeting-a@example.com", 5, "juan@work.example", "Meeting A (attendee copy, higher SEQUENCE)", "20261102T100000Z"),
      shared("meeting-b@example.com", 3, "boss@corp.example", "Meeting B (newest copy)", "20261103T100000Z"),
    )), { sourceCalendarId: "team", priority: 1, ownerAddresses: ["mailto:juan@team.example"] });
    const out = await project(virtual, [...work, ...team]);
    expect(Object.fromEntries(out.map((o) => [o.sourceUid, title(o.resource.master)]))).toEqual({
      "meeting-a@example.com": "Meeting A (organizer copy)",
      "meeting-b@example.com": "Meeting B (newest copy)",
    });
  });
});

describe("privacy", () => {
  // One event carrying every property non-full modes must drop, on the master and on two overrides.
  const leaky = parse(calendar(
    [
      "UID:leaky-secret@example.com", "DTSTAMP:20261101T120000Z", "CREATED:20261001T120000Z", "LAST-MODIFIED:20261101T110000Z",
      "SEQUENCE:7", "CLASS:PUBLIC", "DTSTART;X-SECRET-PARAM=secret-param:20261102T090000Z", "DTEND:20261102T100000Z",
      "RRULE:FREQ=WEEKLY;COUNT=10", 'SUMMARY;ALTREP="https://example.com/secret-altrep":Visible title',
      "DESCRIPTION:secret description", "LOCATION:secret location", "URL:https://example.com/secret-url",
      "ATTACH:https://example.com/secret-attach.pdf", "CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join:https://meet.example.com/secret-conf",
      "GEO:52.52;13.40", "CATEGORIES:SecretCategory", "ORGANIZER;CN=Secret Org:mailto:secret-organizer@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:secret-attendee@example.com", 'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="Secret place":geo:52.52,13.40',
      "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "COLOR:teal", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:secret alarm", "TRIGGER:-PT10M", "END:VALARM",
    ],
    ...["20261109T090000Z", "20261116T090000Z"].map((rid) => [
      "UID:leaky-secret@example.com", "DTSTAMP:20261101T120000Z", "SEQUENCE:8", `RECURRENCE-ID:${rid}`, `DTSTART:${rid.replace("T09", "T11")}`,
      `DTEND:${rid.replace("T09", "T12")}`, "SUMMARY:Visible moved", `LOCATION:secret override location ${rid}`,
      `ATTENDEE;PARTSTAT=ACCEPTED:mailto:secret-override-${rid}@example.com`, "X-GOOGLE-CONFERENCE:https://meet.google.com/secret", "CLASS:PUBLIC",
    ]),
  ));
  const FORBIDDEN = [
    "ATTENDEE", "ORGANIZER", "LOCATION", "DESCRIPTION", "URL", "ATTACH", "CONFERENCE", "GEO", "CATEGORIES", "CREATED",
    "LAST-MODIFIED", "SEQUENCE", "CLASS", "X-APPLE-STRUCTURED-LOCATION", "X-MICROSOFT-CDO-BUSYSTATUS", "X-GOOGLE-CONFERENCE",
  ];

  for (const privacy of ["busy-only", "title-only"] as const)
    test(`${privacy} output contains none of the dropped properties anywhere`, async () => {
      const out = await projectText(spec({ privacy, keepAlarms: true }), source(leaky));
      expect(out.match(/^BEGIN:VEVENT$/gm)).toHaveLength(3);
      for (const name of FORBIDDEN) expect(lines(out).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`))).toEqual([]);
      expect(lines(out).filter((l) => l.startsWith("X-") || /;X-/.test(l) || l.includes("ALTREP"))).toEqual([]);
      expect(out).not.toContain("VALARM");
      expect(out.toLowerCase()).not.toContain("secret");
      expect(out.match(/^SUMMARY:.*$/gm)).toEqual(
        privacy === "busy-only" ? ["SUMMARY:Busy", "SUMMARY:Busy", "SUMMARY:Busy"] : ["SUMMARY:Visible title", "SUMMARY:Visible moved", "SUMMARY:Visible moved"],
      );
      expect(names(out).has("COLOR")).toBe(privacy === "title-only");
    });

  test("busy-only DTSTAMP is the constant and the output parses with ical.js", async () => {
    const out = await projectText(spec({ privacy: "busy-only" }), source([...leaky, ...tricky]));
    expect(BUSY_DTSTAMP).toBe("1970-01-01T00:00:00Z");
    const stamps = lines(out).filter((l) => l.startsWith("DTSTAMP"));
    expect(stamps.length).toBeGreaterThan(0);
    expect(new Set(stamps)).toEqual(new Set(["DTSTAMP:19700101T000000Z"]));
    expect(() => new ICAL.Component(ICAL.parse(out))).not.toThrow();
    expect(parseCalendar(out).errors).toEqual([]);
  });

  test("CLASS:PRIVATE in title-only projects as Busy", async () => {
    const [flight] = await project(spec({ privacy: "title-only" }), source([byUid("flight@example.com")]));
    expect(flight?.resource.master && summary(flight.resource.master)).toBe("Busy");
  });
});

describe("filters and EXDATEs", () => {
  const WEEKS = { from: Temporal.Instant.from("2026-11-01T00:00:00Z"), to: Temporal.Instant.from("2026-12-01T00:00:00Z") };
  const rid = Temporal.Instant.from("2026-11-09T09:00:00Z");
  // A weekly series of four with one changed instance on 9 Nov.
  const series = (masterExtra: string[], overrideExtra: string[], overrideTiming = ["DTSTART:20261109T090000Z", "DTEND:20261109T100000Z"]) =>
    parse(calendar(
      ["UID:series@example.com", "DTSTAMP:20261101T000000Z", "DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Series", ...masterExtra],
      ["UID:series@example.com", "DTSTAMP:20261101T000000Z", "RECURRENCE-ID:20261109T090000Z", ...overrideTiming, "SUMMARY:Changed", ...overrideExtra],
    ));
  const starts = (r: EventResource | undefined) => (r ? expandOccurrences(r, WEEKS).occurrences.map((o) => o.start.toString()) : []);
  // The hidden instance becomes an EXDATE on the master: three instances remain, none on 9 Nov.
  const expectExcluded = async (s: PublicationSpec, inputs: SourceResource[]) => {
    const [obj] = await project(s, inputs);
    expect(obj?.resource.overrides).toEqual([]);
    expect(render(obj ? [obj.resource] : [])).toContain("EXDATE:20261109T090000Z");
    expect(starts(obj?.resource)).toHaveLength(3);
    expect(starts(obj?.resource)).not.toContain(rid.toString());
  };

  test("hideCancelled: a cancelled override becomes an EXDATE; a cancelled master drops the resource", async () => {
    const inputs = source(series([], ["STATUS:CANCELLED"]));
    expect(starts((await project(spec(), inputs))[0]?.resource)).toContain(rid.toString());
    await expectExcluded(spec({ filters: filters({ hideCancelled: true }) }), inputs);
    expect(await project(spec({ filters: filters({ hideCancelled: true }) }), source(series(["STATUS:CANCELLED"], [])))).toEqual([]);
  });

  test("hideDeclined: the owner declining one instance becomes an EXDATE; declining the series drops it", async () => {
    const declined = "ATTENDEE;PARTSTAT=DECLINED:mailto:Me@Example.com";
    const hide = spec({ filters: filters({ hideDeclined: true }) });
    await expectExcluded(hide, source(series(["ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com"], [declined])));
    expect(await project(hide, source(series([declined], [])))).toEqual([]);
    const otherDeclined = source(series([], ["ATTENDEE;PARTSTAT=DECLINED:mailto:someone@example.com"]));
    expect((await project(hide, otherDeclined))[0]?.resource.overrides).toHaveLength(1);
  });

  test("hideAllDay: all-day masters drop, all-day overrides become EXDATEs", async () => {
    const hide = spec({ filters: filters({ hideAllDay: true }) });
    expect(await project(hide, source([byUid("allday@example.com")]))).toEqual([]);
    await expectExcluded(hide, source(series([], [], ["DTSTART;VALUE=DATE:20261109"])));
  });

  test("busy-only: a transparent override becomes an EXDATE", async () => {
    const inputs = source(series([], ["TRANSP:TRANSPARENT"]));
    await expectExcluded(spec({ privacy: "busy-only" }), inputs);
    expect((await project(spec({ privacy: "title-only" }), inputs))[0]?.resource.overrides).toHaveLength(1);
  });
});

describe("output UIDs and hrefs", () => {
  const b64 = (b: Buffer) => b.toString("base64url");
  const uid = "weekly-sync@example.com";
  const weekly = source([byUid(uid)]);
  const projectedUids = async (s: PublicationSpec) => {
    const [obj] = await project(s, weekly);
    if (!obj) throw new Error("nothing projected");
    const all = [obj.resource.master, ...obj.resource.overrides].map((c) => c && textValue(c, "uid"));
    expect(new Set(all)).toEqual(new Set([obj.outputUid])); // master and every override agree
    expect(obj.href).toBe(await hrefFor(s, uid));
    expect(obj.href).toBe(`${b64(createHash("sha256").update(obj.outputUid).digest()).slice(0, 22)}.ics`);
    return obj.outputUid;
  };

  test("passthrough + full keeps the source UID", async () => {
    expect(await projectedUids(spec())).toBe(uid);
  });

  test("virtual + full hashes, title-only and busy-only use the HMAC, per publication", async () => {
    const input = (pubId: string) => `${pubId}\u0000${uid}`;
    for (const kind of ["passthrough", "virtual"] as const)
      for (const privacy of ["title-only", "busy-only"] as const)
        expect(await projectedUids(spec({ kind, privacy }))).toBe(`${b64(createHmac("sha256", SECRET).update(input("pub_test")).digest()).slice(0, 26)}@supercal`);
    expect(await projectedUids(spec({ kind: "virtual" }))).toBe(`${b64(createHash("sha256").update(input("pub_test")).digest()).slice(0, 26)}@supercal`);

    for (const s of [spec({ kind: "virtual" }), spec({ privacy: "busy-only" })]) {
      const other = { ...s, id: "pub_other" };
      expect(await projectedUids(other)).not.toBe(await projectedUids(s));
      expect(await hrefFor(other, uid)).not.toBe(await hrefFor(s, uid));
    }
  });

  test("objectEtag is a quoted hash of publication, epoch, UID and seq", async () => {
    const etag = await objectEtag(spec(), 1, uid, 42n);
    expect(etag).toMatch(/^"[\w-]{27}"$/);
    expect(await objectEtag({ id: "pub_test" }, 1, uid, 42)).toBe(etag);
    for (const changed of [objectEtag(spec(), 2, uid, 42), objectEtag(spec(), 1, uid, 43), objectEtag(spec({ id: "pub_x" }), 1, uid, 42)])
      expect(await changed).not.toBe(etag);
  });
});

test("determinism: same inputs give byte-identical output regardless of order", async () => {
  const s = spec({ kind: "virtual", privacy: "title-only", filters: filters({ hideCancelled: true }) });
  const inputs = [
    ...source(tricky, { sourceCalendarId: "a", priority: 1 }),
    // Ties with "a" on every merge criterion but differs in content, so only the source-id tie-break decides.
    ...source(parse(render(tricky).replaceAll("SUMMARY:Weekly sync (moved)", "SUMMARY:Weekly sync (moved in b)")), { sourceCalendarId: "b", priority: 1 }),
    ...source([byUid("flight@example.com")], { sourceCalendarId: "c", priority: 0 }),
  ];
  const expected = await projectText(s, inputs);
  expect(await projectText(s, inputs)).toBe(expected);
  const shuffles = [[...inputs].reverse(), [...inputs.slice(3), ...inputs.slice(0, 3)], inputs.filter((_, i) => i % 2).concat(inputs.filter((_, i) => !(i % 2)))];
  for (const shuffled of shuffles) expect(await projectText(s, shuffled)).toBe(expected);
});

describe("projectCombined", () => {
  const busy = spec({ id: "pub_1", privacy: "busy-only" });
  const full = spec({ id: "pub_2", kind: "virtual" });

  test("a UID in publications 1 and 2 appears once, with publication 1's projection", async () => {
    const out = await projectCombined([
      { spec: full, sortOrder: 2, inputs: source([byUid("weekly-sync@example.com"), byUid("floating@example.com")]) },
      { spec: busy, sortOrder: 1, inputs: source([byUid("weekly-sync@example.com")]) },
    ]);
    expect(out.map((o) => o.sourceUid).sort()).toEqual(["floating@example.com", "weekly-sync@example.com"]);
    const weekly = out.find((o) => o.sourceUid === "weekly-sync@example.com");
    expect(weekly?.outputUid).toBe((await project(busy, source([byUid("weekly-sync@example.com")])))[0]?.outputUid ?? "");
    expect(weekly?.resource.master && summary(weekly.resource.master)).toBe("Busy");
    const floating = out.find((o) => o.sourceUid === "floating@example.com");
    expect(floating?.resource.master && summary(floating.resource.master)).toBe("Floating wake-up (local everywhere)");
  });

  test("an event the first publication hides does not resurface through a later one", async () => {
    const out = await projectCombined([
      { spec: busy, sortOrder: 1, inputs: source([byUid("allday@example.com")]) },
      { spec: full, sortOrder: 2, inputs: source([byUid("allday@example.com")]) },
    ]);
    expect(out).toEqual([]);
  });
});
