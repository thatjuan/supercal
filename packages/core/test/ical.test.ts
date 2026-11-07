import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getProp, parseCalendar, propParam, propValues, serializeCalendar } from "../src/index.ts";

const tricky = readFileSync(new URL("./fixtures/tricky.ics", import.meta.url), "utf8");

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);

// A content line with its name upper-cased and parameters sorted and unquoted where safe, so
// equivalent spellings compare equal (same normalisation as the spike's q4-ical harness).
function norm(line: string): string {
  const m = /^([^;:]+)((?:;[^=]+=(?:"[^"]*"|[^;:]*))*):(.*)$/.exec(line);
  if (!m) return line;
  const [, name = "", rawParams = "", value = ""] = m;
  const params = [...rawParams.matchAll(/;([^=]+)=("[^"]*"|[^;:]*)/g)]
    .map(([, k = "", v = ""]) => `${k.toUpperCase()}=${/[,;:]/.test(v.replace(/^"|"$/g, "")) ? v : v.replace(/^"|"$/g, "")}`)
    .sort();
  return [name.toUpperCase(), ...params].join(";") + ":" + value;
}

// Multiset of "component path :: content line", so reordering does not count as a change.
function inventory(ics: string): Map<string, number> {
  const out = new Map<string, number>();
  const stack: string[] = [];
  for (const l of unfold(ics)) {
    if (l.startsWith("BEGIN:")) stack.push(l.slice(6));
    else if (l.startsWith("END:")) stack.pop();
    else {
      const k = `${stack.join("/")} :: ${norm(l)}`;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

const minus = (a: Map<string, number>, b: Map<string, number>) =>
  [...a].filter(([k, n]) => (b.get(k) ?? 0) < n).map(([k]) => k).sort();

describe("parseCalendar / serializeCalendar round trip on tricky.ics", () => {
  const parsed = parseCalendar(tricky);
  const out = serializeCalendar({ props: parsed.calendarProps, resources: parsed.resources });

  test("groups VEVENTs by UID with overrides and VTIMEZONEs attached", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.resources.map((r) => [r.uid, r.overrides.length])).toEqual([
      ["weekly-sync@example.com", 2],
      ["allday@example.com", 0],
      ["floating@example.com", 0],
      ["flight@example.com", 0],
    ]);
    expect(Object.keys(parsed.resources[0]?.timezones ?? {})).toEqual(["America/New_York"]);
    expect(Object.keys(parsed.resources[3]?.timezones ?? {}).sort()).toEqual(["America/New_York", "Europe/Berlin"]);
  });

  test("only the TEXT ';' re-escape and our PRODID change", () => {
    const before = inventory(tricky);
    const after = inventory(out);
    expect(minus(before, after)).toEqual([
      "VCALENDAR :: PRODID:-//Supercal Spike//Fixtures//EN",
      "VCALENDAR/VEVENT :: SUMMARY:Weekly sync\\, team; all hands",
    ]);
    expect(minus(after, before)).toEqual([
      "VCALENDAR :: PRODID:-//Supercal//EN",
      "VCALENDAR/VEVENT :: SUMMARY:Weekly sync\\, team\\; all hands",
    ]);
  });

  test("re-parsing the output yields the same jCal", () => {
    const again = parseCalendar(out);
    expect(again.resources).toEqual(parsed.resources);
    expect(again.calendarProps.filter((p) => p[0] !== "prodid")).toEqual(parsed.calendarProps.filter((p) => p[0] !== "prodid"));
  });

  test("keeps X-props with params, THISANDFUTURE, RFC 7986 and floating times", () => {
    const lines = unfold(out).map(norm);
    const has = (line: string) => expect(lines).toContain(norm(line));
    has("X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Room 1;X-APPLE-RADIUS=70:geo:40.7,-74.0");
    has("X-CUSTOM-CAL;X-PARAM=a:calendar level x-prop");
    has("RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20270104T090000");
    has("NAME:Tricky fixtures");
    has("COLOR:crimson");
    has("REFRESH-INTERVAL;VALUE=DURATION:PT15M");
    has("CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join:https://meet.example.com/abc");
    has("DTSTART:20261105T070000");
    has("RRULE:FREQ=DAILY;UNTIL=20261110T070000");

    const conference = parsed.resources[0]?.master && getProp(parsed.resources[0].master, "conference");
    expect(conference && propParam(conference, "feature")).toBe("AUDIO,VIDEO");
    expect(conference?.[1].feature).toEqual(["AUDIO", "VIDEO"]);
  });

  test("folds at 75 octets without splitting multi-byte characters", () => {
    const physical = out.split("\r\n");
    const enc = new TextEncoder();
    expect(Math.max(...physical.map((l) => enc.encode(l).length))).toBeLessThanOrEqual(75);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(physical.some((l) => loneSurrogate.test(l))).toBe(false);
    const description = parsed.resources[1]?.master && getProp(parsed.resources[1].master, "description");
    expect(description && propValues(description)[0]).toBe(`${"日本語のテキストと絵文字🎉を含む長い説明文です。".repeat(4)} ALTREP-free end`);
    expect(physical.filter((l) => l.startsWith(" ")).length).toBeGreaterThan(2);
  });
});

describe("parseCalendar", () => {
  test("reports a malformed component and keeps the rest", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:bad@example.com",
      "DTSTART this line has no colon",
      "END:VEVENT",
      "BEGIN:VTODO",
      "UID:todo@example.com",
      "END:VTODO",
      "BEGIN:VEVENT",
      "UID:good@example.com",
      "DTSTART:20261105T070000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const r = parseCalendar(text);
    expect(r.resources.map((x) => x.uid)).toEqual(["good@example.com"]);
    expect(r.errors).toEqual([expect.objectContaining({ component: "vevent", uid: "bad@example.com" })]);
  });
});
