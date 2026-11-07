// Q4: parse -> serialise fidelity of candidate iCalendar libraries on fixtures/tricky.ics.
// Compares the multiset of (component path, property line) before and after a roundtrip.
import ICAL from "ical.js";
import { convertIcsCalendar, generateIcsCalendar } from "ts-ics";
import { parse as sdxParse, stringify as sdxStringify } from "@sdxc/icalendar";
import nodeIcal from "node-ical";

const src = await Bun.file(new URL("../fixtures/tricky.ics", import.meta.url)).text();

const unfold = (s: string) => s.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);

// Normalise a content line: upper-case name, sorted params, unquoted param values where safe.
function norm(line: string): string {
  const m = /^([^;:]+)((?:;[^=]+=(?:"[^"]*"|[^;:]*))*):(.*)$/.exec(line);
  if (!m) return line;
  const [, name = "", rawParams = "", value = ""] = m;
  const params = [...rawParams.matchAll(/;([^=]+)=("[^"]*"|[^;:]*)/g)]
    .map(([, k = "", v = ""]) => `${k.toUpperCase()}=${/[,;:]/.test(v.replace(/^"|"$/g, "")) ? v : v.replace(/^"|"$/g, "")}`)
    .sort();
  return [name.toUpperCase(), ...params].join(";") + ":" + value;
}

// Key every property by its component path + UID/RECURRENCE-ID so reordering does not count as loss.
function inventory(ics: string): Map<string, number> {
  const out = new Map<string, number>();
  const stack: string[] = [];
  const lines = unfold(ics);
  let ctx: string[] = [];
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const l of lines) {
    if (l.startsWith("BEGIN:")) {
      stack.push(l.slice(6));
      ctx = [];
      continue;
    }
    if (l.startsWith("END:")) {
      stack.pop();
      continue;
    }
    if (/^(UID|RECURRENCE-ID|TZID)[;:]/.test(l)) ctx.push(norm(l));
    add(`${stack.join("/")} :: ${norm(l)}`);
  }
  void ctx;
  return out;
}

function diff(label: string, out: string) {
  const a = inventory(src);
  const b = inventory(out);
  const lost: string[] = [];
  for (const [k, n] of a) if ((b.get(k) ?? 0) < n) lost.push(k);
  const added: string[] = [];
  for (const [k, n] of b) if ((a.get(k) ?? 0) < n) added.push(k);
  const maxOctets = Math.max(...out.split(/\r?\n/).map((l) => new TextEncoder().encode(l).length));
  const badFold = out.split(/\r?\n/).some((l) => l.includes("�"));
  const crlf = out.includes("\r\n");
  console.log(`\n=== ${label}: ${lost.length} input lines lost/changed, ${added.length} new/changed in output; max line ${maxOctets} octets; CRLF=${crlf}; broken UTF-8 fold=${badFold}`);
  for (const l of lost.slice(0, 40)) console.log("  - " + l.slice(0, 150));
  for (const l of added.slice(0, 40)) console.log("  + " + l.slice(0, 150));
}

// ical.js: component tree, keeps every property including unknown ones.
{
  const comp = new ICAL.Component(ICAL.parse(src));
  diff("ical.js 2.2.1 (parse + toString)", comp.toString());
  // typed access to overrides
  const events = comp.getAllSubcomponents("vevent").map((v) => new ICAL.Event(v));
  const master = events.find((e) => e.uid === "weekly-sync@example.com" && !e.isRecurrenceException());
  if (master) {
    for (const ex of events.filter((e) => e.isRecurrenceException())) master.relateException(ex);
    const it = master.iterator();
    const occ: string[] = [];
    for (let n = it.next(), i = 0; n && i < 12; n = it.next(), i++) {
      const d = master.getOccurrenceDetails(n);
      occ.push(`${d.startDate.toString()}${d.item !== master ? "*" : ""}`);
    }
    console.log("  ical.js expansion (first 12, * = override):", occ.join(" "));
    const thisAndFuture = master.exceptions; // keyed by recurrence-id string
    console.log("  ical.js override keys:", Object.keys(thisAndFuture).join(", "), "| THISANDFUTURE ranged:", events.some((e) => e.component.getFirstProperty("recurrence-id")?.getParameter("range") === "THISANDFUTURE"));
  }
}

// ts-ics: typed object model, generate from it.
{
  try {
    const cal = convertIcsCalendar(undefined, src);
    diff("ts-ics 2.4.8 (convertIcsCalendar + generateIcsCalendar)", generateIcsCalendar(cal));
    const evs = cal.events ?? [];
    console.log("  ts-ics events:", evs.length, "with recurrenceId:", evs.filter((e) => e.recurrenceId).length, "| nonStandard on master:", JSON.stringify(evs[0]?.nonStandard ?? null));
  } catch (e) {
    console.log("\n=== ts-ics threw:", (e as Error).message);
  }
}

// @sdxc/icalendar: typed model + verbatim unknown properties.
{
  const r = sdxParse(src);
  if ("data" in r && r.data) {
    diff("@sdxc/icalendar 2026.11.3 (parse + stringify)", sdxStringify(r.data.calendar));
    console.log("  sdxc warnings:", r.data.warnings.length, r.data.warnings.slice(0, 3).join(" | "));
  } else console.log("\n=== @sdxc/icalendar parse failed", JSON.stringify(r).slice(0, 300));
}

// node-ical: parse only. Check it sees overrides and THISANDFUTURE.
{
  const parsed = nodeIcal.sync.parseICS(src);
  const master = Object.values(parsed).find((c) => c && c.type === "VEVENT" && c.uid === "weekly-sync@example.com");
  const rec = master && "recurrences" in master ? Object.keys(master.recurrences ?? {}) : [];
  console.log("\n=== node-ical 0.27.5 (parse only): overrides keyed", rec.join(", "), "| no serialiser, so no passthrough");
}
