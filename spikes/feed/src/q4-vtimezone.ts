// Q4: which source emits correct VTIMEZONE blocks from IANA names?
// For each generator, load its VTIMEZONE into ical.js and compare the UTC offset it yields
// against Intl (ICU tzdata shipped with Bun) every 6 hours across a historic and a future window.
import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";
import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import { stringify as sdxStringify } from "@sdxc/icalendar";
import { vtimezone as sdxVtimezone } from "@sdxc/icalendar/timezone";

const zones = [
  "America/New_York", "Europe/Berlin", "Europe/London", "Australia/Lord_Howe", "America/Sao_Paulo",
  "Africa/Casablanca", "Asia/Tehran", "Europe/Kyiv", "Pacific/Chatham", "America/Santiago",
  "Asia/Kolkata", "America/Nuuk", "Pacific/Apia", "Asia/Gaza", "America/Mexico_City",
];
const windows = { "2015-2019": [Date.UTC(2015, 0, 1), Date.UTC(2020, 0, 1)], "2025-2034": [Date.UTC(2025, 0, 1), Date.UTC(2035, 0, 1)] } as const;

function intlOffsetMinutes(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t);
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t) / 60000;
}

function loadZone(vtz: string): ICAL.Timezone {
  const comp = new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\n${vtz.trim()}\r\nEND:VCALENDAR\r\n`)).getFirstSubcomponent("vtimezone");
  if (!comp) throw new Error("no vtimezone");
  return new ICAL.Timezone(comp);
}

// Instant -> wall clock is unambiguous (local -> offset is not, at fall-back hours), so derive the
// offset from the wall clock ical.js produces for a UTC instant.
function icalOffsetMinutes(zone: ICAL.Timezone, t: number): number {
  const local = ICAL.Time.fromJSDate(new Date(t), true).convertToZone(zone);
  return (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - t) / 60000;
}

type Gen = (tz: string, from: number, to: number) => string | null;
const generators: Record<string, Gen> = {
  "timezones-ical-library@2.4.0": (tz) => {
    const b = tzlib_get_ical_block(tz);
    return Array.isArray(b) && typeof b[0] === "string" ? b[0] : null;
  },
  "@touch4it/ical-timezones@1.9.0": (tz) => getVtimezoneComponent(tz),
  "@sdxc/icalendar/timezone (Intl, span-bounded)": (tz, from, to) => {
    const r = sdxVtimezone(tz, { from: from - 2 * 86400_000, to }); // pad: first observance starts at local span start
    if (!("data" in r) || !r.data) return null;
    const text = sdxStringify({ productId: "x", timeZones: [r.data], events: [], components: [], properties: [] });
    return /BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE/.exec(text)?.[0] ?? null;
  },
};

for (const [gname, gen] of Object.entries(generators)) {
  console.log(`\n=== ${gname}`);
  for (const [wname, [from, to]] of Object.entries(windows)) {
    const bad: string[] = [];
    let checked = 0;
    for (const tz of zones) {
      const vtz = gen(tz, from, to);
      if (!vtz) {
        bad.push(`${tz}: no block`);
        continue;
      }
      const zone = loadZone(vtz);
      let wrong = 0;
      let firstWrong = "";
      for (let t = from; t < to; t += 6 * 3600_000) {
        checked++;
        const a = intlOffsetMinutes(tz, t);
        const b = icalOffsetMinutes(zone, t);
        if (a !== b) {
          wrong++;
          if (!firstWrong) firstWrong = `${new Date(t).toISOString().slice(0, 13)} intl=${a} vtz=${b}`;
        }
      }
      if (wrong) bad.push(`${tz}: ${wrong} wrong samples, first ${firstWrong}`);
    }
    console.log(`  window ${wname}: ${checked} samples, ${bad.length}/${zones.length} zones wrong`);
    for (const b of bad) console.log("    " + b);
  }
}
