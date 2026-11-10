/**
 * The only module that imports ical.js. It parses and serialises iCalendar text and generates
 * RRULE wall times; everything else works on jCal through `accessors.ts`. ical.js is never used
 * for UTC↔zone conversion (it is off by an hour before DST transitions); see `time.ts`.
 */
import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import {
  compareRevision,
  componentName,
  propName,
  properties,
  recurrenceId,
  subcomponents,
  textValue,
  tzidsOf,
  uidOf,
} from "./accessors.ts";
import type { EventResource, JCalComponent, JCalProperty } from "./model.ts";

// Without this ical.js re-quotes FEATURE=AUDIO,VIDEO into the single value "AUDIO,VIDEO".
Object.assign(ICAL.design.icalendar.param, { feature: { multiValue: "," }, role: { multiValue: "," } });

export const PRODID = "-//Supercal//EN";

export type ParseError = { component: string; uid: string | null; message: string };
export type ParsedCalendar = { resources: EventResource[]; calendarProps: JCalProperty[]; errors: ParseError[] };

type Block = { name: string; lines: string[] };

// Splits text into VCALENDAR-level property lines and top-level component blocks, so one
// malformed component cannot fail the whole file. Folded continuation lines stay attached.
export function splitTopLevel(text: string): { calendarLines: string[]; blocks: Block[]; errors: ParseError[] } {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split(/\n(?![ \t])/)
    .filter((l) => l.trim() !== "");
  const calendarLines: string[] = [];
  const blocks: Block[] = [];
  const errors: ParseError[] = [];
  let depth = 0;
  let current: Block | null = null;
  for (const line of lines) {
    const begin = /^BEGIN:(.+)$/i.exec(line.trim())?.[1]?.toLowerCase();
    const end = /^END:(.+)$/i.exec(line.trim())?.[1]?.toLowerCase();
    if (begin) {
      depth++;
      if (depth === 2) current = { name: begin, lines: [] };
    }
    if (current) current.lines.push(line);
    else if (depth === 1 && !begin && !end) calendarLines.push(line);
    if (end) {
      if (depth === 2 && current) {
        blocks.push(current);
        current = null;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  if (current) errors.push({ component: current.name, uid: uidInLines(current.lines), message: `unterminated ${current.name.toUpperCase()}` });
  return { calendarLines, blocks, errors };
}

const uidInLines = (lines: string[]): string | null =>
  lines.map((l) => /^UID[;:](?:[^:]*:)?(.*)$/i.exec(l)?.[1]?.trim()).find((u) => u) ?? null;

// ical.js's parser is untyped; its output for a VCALENDAR wrapper is a jCal component.
function parseWrapped(lines: string[]): JCalComponent {
  const jcal: JCalComponent = ICAL.parse(["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n"));
  return jcal;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Parses iCalendar text into one EventResource per UID. VEVENTs are grouped by UID (one master,
 * overrides sorted by RECURRENCE-ID; duplicates resolved by SEQUENCE then LAST-MODIFIED, ties
 * keep the first), VTIMEZONEs are attached to the resources that reference them, VTODO/VJOURNAL
 * are ignored and malformed components are reported in `errors` instead of throwing.
 */
export function parseCalendar(text: string): ParsedCalendar {
  const { calendarLines, blocks, errors } = splitTopLevel(text);
  let calendarProps: JCalProperty[] = [];
  try {
    calendarProps = properties(parseWrapped(calendarLines));
  } catch (e) {
    errors.push({ component: "vcalendar", uid: null, message: errorMessage(e) });
  }

  const timezones = new Map<string, JCalComponent>();
  const groups = new Map<string, { master: JCalComponent | null; overrides: Map<string, JCalComponent> }>();
  for (const block of blocks) {
    if (block.name !== "vevent" && block.name !== "vtimezone") continue;
    let comp: JCalComponent | undefined;
    try {
      comp = subcomponents(parseWrapped(block.lines))[0];
    } catch (e) {
      errors.push({ component: block.name, uid: uidInLines(block.lines), message: errorMessage(e) });
      continue;
    }
    if (!comp) continue;
    if (componentName(comp) === "vtimezone") {
      const tzid = textValue(comp, "tzid");
      if (typeof tzid === "string") timezones.set(tzid, comp);
      else errors.push({ component: "vtimezone", uid: null, message: "VTIMEZONE without TZID" });
      continue;
    }
    const uid = uidOf(comp);
    if (!uid) {
      errors.push({ component: "vevent", uid: null, message: "VEVENT without UID" });
      continue;
    }
    const group = groups.get(uid) ?? { master: null, overrides: new Map() };
    groups.set(uid, group);
    const rid = recurrenceId(comp);
    const existing = rid === null ? group.master : group.overrides.get(rid);
    if (existing && compareRevision(comp, existing) <= 0) continue;
    if (rid === null) group.master = comp;
    else group.overrides.set(rid, comp);
  }

  const resources = [...groups].map(([uid, g]): EventResource => {
    const overrides = [...g.overrides].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
    const used = new Set([g.master, ...overrides].flatMap((c) => (c ? [...tzidsOf(c)] : [])));
    const tzs = Object.fromEntries([...used].flatMap((id) => {
      const tz = timezones.get(id);
      return tz ? [[id, tz] as const] : [];
    }));
    return { uid, master: g.master, overrides, timezones: tzs };
  });
  return { resources, calendarProps, errors };
}

/** Components of a resource in output order: master first, then overrides. */
export const componentsOf = (r: EventResource): JCalComponent[] => (r.master ? [r.master, ...r.overrides] : [...r.overrides]);

/**
 * Serialises one VCALENDAR: our PRODID and VERSION, the remaining calendar `props`, the
 * VTIMEZONEs the resources reference (deduped by TZID), then every resource's events. Ends with
 * exactly one CRLF.
 */
export function serializeCalendar({ props, resources }: { props: JCalProperty[]; resources: EventResource[] }): string {
  const calProps: JCalProperty[] = [
    ["prodid", {}, "text", PRODID],
    ["version", {}, "text", "2.0"],
    ...props.filter((p) => propName(p) !== "prodid" && propName(p) !== "version"),
  ];
  const timezones = new Map<string, JCalComponent>();
  for (const r of resources)
    for (const c of componentsOf(r))
      for (const tzid of tzidsOf(c)) {
        const tz = r.timezones[tzid];
        if (tz && !timezones.has(tzid)) timezones.set(tzid, tz);
      }
  const vcalendar: JCalComponent = ["vcalendar", calProps, [...timezones.values(), ...resources.flatMap(componentsOf)]];
  return ICAL.stringify(vcalendar)
    // mapping-29 requires JSPTR to be quoted even when its value needs no escaping.
    .replace(/^JSPROP(?:[^\r\n]|\r\n[ \t])*/gm, (line) => ICAL.helpers.foldline(line.replace(/\r\n[ \t]/g, '').replace(/;JSPTR=([^";:]+)(?=[;:])/, ';JSPTR="$1"')))
    .replace(/(\r\n)*$/, "\r\n");
}

/** One property as an unfolded content line, e.g. `RRULE:FREQ=WEEKLY;BYDAY=MO` (Google `recurrence[]` entries). */
export const propertyLine = (prop: JCalProperty): string => ICAL.stringify.property(structuredClone(prop), ICAL.design.icalendar, true);

/** Thrown when a rule exhausts its step budget; expansion reports it as truncated. */
export class RecurBudgetError extends Error {}
const MAX_STEPS_PER_RULE = 1_000_000;
const MAX_INTERVAL = 100_000;

/**
 * Wall-clock starts generated by an RRULE from DTSTART, in order, starting with DTSTART itself.
 * UNTIL is ignored: ical.js would compare it in the wrong zone, so callers apply it with real
 * instants. COUNT is honoured; callers stop iterating at their horizon or occurrence cap.
 * Excessive stepping or INTERVAL throws RecurBudgetError.
 */
export function* rruleWallTimes(
  rrule: JCalProperty,
  dtstart: Temporal.PlainDateTime | Temporal.PlainDate,
): Generator<Temporal.PlainDateTime | Temporal.PlainDate> {
  const recur = new ICAL.Property(structuredClone(rrule)).getFirstValue();
  if (!(recur instanceof ICAL.Recur)) return;
  recur.until = null;
  const isDate = dtstart instanceof Temporal.PlainDate;
  const start = ICAL.Time.fromData({
    year: dtstart.year,
    month: dtstart.month,
    day: dtstart.day,
    ...(dtstart instanceof Temporal.PlainDateTime && { hour: dtstart.hour, minute: dtstart.minute, second: dtstart.second }),
    isDate,
  });
  // A huge INTERVAL spends its time inside Time normalisation, beyond the step wrappers.
  if (recur.interval > MAX_INTERVAL) throw new RecurBudgetError();
  const it = recur.iterator(start);
  let steps = 0;
  const spend = (cost: number) => {
    if ((steps += cost) > MAX_STEPS_PER_RULE) throw new RecurBudgetError();
  };
  const methods = it as unknown as Record<string, (...args: unknown[]) => unknown>;
  // next() loops internally on these when rules match rarely or never.
  for (const name of ['next_second', 'next_minute', 'next_hour', 'next_day', 'next_week']) {
    const step = methods[name]!;
    methods[name] = function (this: unknown, ...args: unknown[]) {
      spend(1);
      return step.apply(this, args);
    };
  }
  // This method loops once per day, so charge its whole increment before it runs.
  const addDays = methods.increment_monthday!;
  methods.increment_monthday = function (this: unknown, ...args: unknown[]) {
    spend(args[0] as number);
    return addDays.apply(this, args);
  };
  for (let t = it.next(); t; t = it.next()) {
    const fields = { year: t.year, month: t.month, day: t.day };
    yield isDate ? Temporal.PlainDate.from(fields) : Temporal.PlainDateTime.from({ ...fields, hour: t.hour, minute: t.minute, second: t.second });
  }
}

const loadedZones = new WeakMap<JCalComponent, ICAL.Timezone>();

/**
 * UTC offset in seconds that a source-supplied VTIMEZONE gives a local wall time. Used only for
 * TZIDs that are not IANA names; local→UTC lookup is not affected by ical.js's UTC→zone bug.
 */
export function vtimezoneUtcOffset(vtimezone: JCalComponent, wall: Temporal.PlainDateTime): number {
  let zone = loadedZones.get(vtimezone);
  if (!zone) {
    zone = new ICAL.Timezone(new ICAL.Component(structuredClone(vtimezone)));
    loadedZones.set(vtimezone, zone);
  }
  return zone.utcOffset(
    ICAL.Time.fromData({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second }),
  );
}
