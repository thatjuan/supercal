// Internal event model: one EventResource per UID = master + overrides, stored as jCal (RFC 7265)
// so every property ical.js does not know (X-*, RFC 7986, vendor params) survives untouched.
// Typed accessors live here; nothing outside this file touches raw jCal.
import ICAL from "ical.js";

// ical.js quotes multi-valued params it does not know (FEATURE=AUDIO,VIDEO -> FEATURE="AUDIO,VIDEO").
const designParams = ICAL.design.icalendar.param as Record<string, { multiValue?: string }>;
designParams["feature"] = { multiValue: "," };

type JCal = ReturnType<ICAL.Component["toJSON"]>;

export type EventResource = {
  uid: string;
  master: JCal | null; // null when we only see detached instances (invited to one occurrence)
  overrides: JCal[]; // VEVENTs carrying RECURRENCE-ID
  timezones: Record<string, JCal>; // VTIMEZONE by TZID, as the source supplied them
};

export type Privacy = "full" | "title-only" | "busy-only";

export type ResourceMeta = { sequence: number; lastModified: Date | null; organizer: string | null; span: [Date, Date] };

const FAR_FUTURE = new Date("9999-01-01T00:00:00Z");

/** Split a VCALENDAR into EventResources keyed by UID. */
export function resourcesFromIcs(ics: string): EventResource[] {
  const cal = new ICAL.Component(ICAL.parse(ics));
  const tzs: Record<string, JCal> = {};
  for (const tz of cal.getAllSubcomponents("vtimezone")) {
    const id = tz.getFirstPropertyValue("tzid");
    if (typeof id === "string") tzs[id] = tz.toJSON();
  }
  const byUid = new Map<string, EventResource>();
  for (const ev of cal.getAllSubcomponents("vevent")) {
    const uid = String(ev.getFirstPropertyValue("uid") ?? "");
    if (!uid) continue;
    const r = byUid.get(uid) ?? { uid, master: null, overrides: [], timezones: {} };
    if (ev.hasProperty("recurrence-id")) r.overrides.push(ev.toJSON());
    else r.master = ev.toJSON();
    for (const p of ev.getAllProperties()) {
      const tzid = p.getParameter("tzid");
      if (typeof tzid === "string" && tzs[tzid]) r.timezones[tzid] = tzs[tzid];
    }
    byUid.set(uid, r);
  }
  return [...byUid.values()];
}

// ICAL.Component wraps the jCal array without copying, so clone before projections mutate it.
const comps = (r: EventResource) => [r.master, ...r.overrides].filter((c): c is JCal => c !== null).map((j) => new ICAL.Component(structuredClone(j)));

function registerZones(r: EventResource) {
  for (const j of Object.values(r.timezones)) {
    const tz = new ICAL.Timezone(new ICAL.Component(j));
    if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
  }
}

/** Derived columns for the resource table. */
export function metaOf(r: EventResource): ResourceMeta {
  registerZones(r);
  const cs = comps(r);
  let sequence = 0;
  let lastModified: Date | null = null;
  let organizer: string | null = null;
  let start = FAR_FUTURE;
  let end = new Date(0);
  for (const c of cs) {
    sequence = Math.max(sequence, Number(c.getFirstPropertyValue("sequence") ?? 0));
    const lm = c.getFirstPropertyValue("last-modified") ?? c.getFirstPropertyValue("dtstamp");
    if (lm instanceof ICAL.Time && (!lastModified || lm.toJSDate() > lastModified)) lastModified = lm.toJSDate();
    organizer ??= (c.getFirstPropertyValue("organizer") as string | null) ?? null;
    const e = new ICAL.Event(c);
    // Floating and all-day values are read as UTC; widen by 14h either side to stay conservative.
    const slack = e.startDate.isDate || !e.startDate.zone || e.startDate.zone.tzid === "floating" ? 14 * 3600_000 : 0;
    const s = new Date(e.startDate.toJSDate().getTime() - slack);
    if (s < start) start = s;
    let en = new Date((e.endDate ?? e.startDate).toJSDate().getTime() + slack);
    const rrule = c.getFirstPropertyValue("rrule");
    if (rrule instanceof ICAL.Recur) {
      if (!rrule.until && !rrule.count) en = FAR_FUTURE;
      else {
        // walk to the last instance (bounded by UNTIL/COUNT)
        const it = e.iterator();
        let last = e.startDate;
        for (let n = it.next(), i = 0; n && i < 5000; n = it.next(), i++) last = n;
        en = new Date(last.toJSDate().getTime() + e.duration.toSeconds() * 1000 + slack + 3600_000);
      }
    }
    if (en > end) end = en;
  }
  return { sequence, lastModified, organizer, span: [start, end > start ? end : new Date(start.getTime() + 1000)] };
}

// Properties that survive each projection. Allowlists, so vendor X- props cannot leak.
const SCHEDULE_PROPS = ["uid", "dtstamp", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate", "recurrence-id", "sequence", "status", "transp", "class", "created", "last-modified"];
const TITLE_ONLY = new Set([...SCHEDULE_PROPS, "summary", "color"]);
const BUSY_ONLY = new Set(SCHEDULE_PROPS);

const isPrivate = (c: ICAL.Component) => {
  const cls = String(c.getFirstPropertyValue("class") ?? "PUBLIC").toUpperCase();
  return cls === "PRIVATE" || cls === "CONFIDENTIAL";
};

function project(c: ICAL.Component, mode: Privacy, keepAlarms: boolean): ICAL.Component | null {
  const transparent = String(c.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase() === "TRANSPARENT";
  // Source CLASS:PRIVATE/CONFIDENTIAL downgrades a title-only publication to busy for that component.
  const effective: Privacy = mode === "title-only" && isPrivate(c) ? "busy-only" : mode;
  if (effective === "busy-only" && transparent && !c.hasProperty("recurrence-id")) return null; // free time is not busy
  if (effective !== "full") {
    const allow = effective === "title-only" ? TITLE_ONLY : BUSY_ONLY;
    // getAll* return ical.js's live arrays: removing while iterating them skips every other item.
    for (const p of [...c.getAllProperties()]) if (!allow.has(p.name)) c.removeProperty(p);
    for (const sub of [...c.getAllSubcomponents()]) c.removeSubcomponent(sub); // VALARM, X-components
    if (effective === "busy-only") c.addPropertyWithValue("summary", "Busy");
    if (effective === "busy-only" && transparent) c.updatePropertyWithValue("status", "CANCELLED"); // free override of a busy series
  } else if (!keepAlarms) {
    for (const a of [...c.getAllSubcomponents("valarm")]) c.removeSubcomponent(a);
  }
  return c;
}

export type RenderOpts = { privacy: Privacy; keepAlarms: boolean; outUid: string };

/** Projected VEVENTs + the VTIMEZONEs they reference. Returns null if nothing is visible. */
export function projectResource(r: EventResource, o: RenderOpts): { events: ICAL.Component[]; timezones: ICAL.Component[] } | null {
  const events: ICAL.Component[] = [];
  for (const c of comps(r)) {
    const p = project(c, o.privacy, o.keepAlarms);
    if (!p) {
      if (!c.hasProperty("recurrence-id")) return null; // transparent master in busy-only: drop the series
      continue;
    }
    p.updatePropertyWithValue("uid", o.outUid);
    events.push(p);
  }
  if (!events.length) return null;
  const used = new Set<string>();
  for (const e of events) for (const p of e.getAllProperties()) {
    const tz = p.getParameter("tzid");
    if (typeof tz === "string") used.add(tz);
  }
  const timezones = [...used].flatMap((id) => (r.timezones[id] ? [new ICAL.Component(structuredClone(r.timezones[id]))] : []));
  return { events, timezones };
}

export function calendarShell(props: Record<string, string> = {}): ICAL.Component {
  const cal = new ICAL.Component("vcalendar");
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("prodid", "-//Supercal//Feed spike//EN");
  for (const [k, v] of Object.entries(props)) cal.addPropertyWithValue(k, v);
  return cal;
}

/** One CalDAV object resource (RFC 4791 4.1: one UID per object). */
export function renderObject(r: EventResource, o: RenderOpts): string | null {
  const p = projectResource(r, o);
  if (!p) return null;
  const cal = calendarShell();
  for (const tz of p.timezones) cal.addSubcomponent(tz);
  for (const e of p.events) cal.addSubcomponent(e);
  return cal.toString() + "\r\n";
}

/** Merge copies of the same UID from several source calendars into one resource.
 *  Per component (master and each RECURRENCE-ID): organizer's copy wins, then higher SEQUENCE,
 *  then later LAST-MODIFIED/DTSTAMP, then lower source priority. */
export type Copy = { r: EventResource; ownerEmail: string | null; priority: number };
export function mergeCopies(copies: Copy[]): EventResource {
  const first = copies[0];
  if (!first) throw new Error("no copies");
  if (copies.length === 1) return first.r;
  const score = (j: JCal, c: Copy) => {
    const comp = new ICAL.Component(j);
    const org = String(comp.getFirstPropertyValue("organizer") ?? "").toLowerCase().replace(/^mailto:/, "");
    const lm = comp.getFirstPropertyValue("last-modified") ?? comp.getFirstPropertyValue("dtstamp");
    return [
      c.ownerEmail && org === c.ownerEmail.toLowerCase() ? 1 : 0,
      Number(comp.getFirstPropertyValue("sequence") ?? 0),
      lm instanceof ICAL.Time ? lm.toJSDate().getTime() : 0,
      -c.priority,
    ];
  };
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
  };
  let master: { j: JCal; s: number[] } | null = null;
  const overrides = new Map<string, { j: JCal; s: number[] }>();
  const timezones: Record<string, JCal> = {};
  for (const c of copies) {
    Object.assign(timezones, c.r.timezones);
    if (c.r.master) {
      const s = score(c.r.master, c);
      if (!master || better(s, master.s)) master = { j: c.r.master, s };
    }
    for (const o of c.r.overrides) {
      const rid = new ICAL.Component(o).getFirstProperty("recurrence-id")?.getFirstValue();
      const key = rid instanceof ICAL.Time ? rid.toJSDate().toISOString() : String(rid);
      const s = score(o, c);
      const cur = overrides.get(key);
      if (!cur || better(s, cur.s)) overrides.set(key, { j: o, s });
    }
  }
  return { uid: first.r.uid, master: master?.j ?? null, overrides: [...overrides.values()].map((v) => v.j), timezones };
}
