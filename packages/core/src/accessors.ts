/**
 * Typed, pure accessors over jCal. This is the only module that indexes into jCal arrays; every
 * function returns new values and never mutates its input. Property and component names are
 * matched case-insensitively (jCal stores them lower-case).
 */
import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { EventResource, JCalComponent, JCalParams, JCalProperty, JCalValue } from "./model.ts";

export const componentName = (c: JCalComponent): string => c[0];
export const subcomponents = (c: JCalComponent, name?: string): JCalComponent[] =>
  name === undefined ? [...c[2]] : c[2].filter((s) => s[0] === name.toLowerCase());

export const propName = (p: JCalProperty): string => p[0];
export const propType = (p: JCalProperty): string => p[2];
export const propValues = (p: JCalProperty): JCalValue[] => p.slice(3);

/** A parameter's value; multi-valued parameters are joined with commas. */
export function propParam(p: JCalProperty, name: string): string | undefined {
  const v = p[1][name.toLowerCase()];
  return Array.isArray(v) ? v.join(",") : v;
}

/** Every property of a component, in order, as a new array. */
export const properties = (c: JCalComponent): JCalProperty[] => [...c[1]];

/** First property with this name. */
export const getProp = (c: JCalComponent, name: string): JCalProperty | undefined =>
  c[1].find((p) => p[0] === name.toLowerCase());

/** Every property with this name, as a new array (never ical.js's live array). */
export const getProps = (c: JCalComponent, name: string): JCalProperty[] => c[1].filter((p) => p[0] === name.toLowerCase());

/** A copy of `c` with every property named like `prop` replaced by `prop`, at the first one's position. */
export function setProp(c: JCalComponent, prop: JCalProperty): JCalComponent {
  const name = prop[0];
  const at = c[1].findIndex((p) => p[0] === name);
  const rest = c[1].filter((p) => p[0] !== name);
  const props = at === -1 ? [...rest, prop] : [...rest.slice(0, at), prop, ...rest.slice(at)];
  return [c[0], props, c[2]];
}

/** A copy of `c` without the named properties. */
export function removeProps(c: JCalComponent, names: readonly string[]): JCalComponent {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return [c[0], c[1].filter((p) => !drop.has(p[0])), c[2]];
}

const firstValue = (c: JCalComponent, name: string): JCalValue | undefined => getProp(c, name)?.[3];
/** First value of the named property when it is a string. */
export function textValue(c: JCalComponent, name: string): string | null {
  const v = firstValue(c, name);
  return typeof v === "string" ? v : null;
}
const text = textValue;

/** The first RRULE with its UNTIL (jCal value) and COUNT, or null when there is none. */
export function rrule(c: JCalComponent): { prop: JCalProperty; until: string | null; count: number | null } | null {
  const prop = getProp(c, "rrule");
  const v = prop?.[3];
  if (!prop || !v || typeof v !== "object" || Array.isArray(v)) return null;
  return { prop, until: typeof v.until === "string" ? v.until : null, count: typeof v.count === "number" ? v.count : null };
}

/** RECURRENCE-ID as its jCal value (e.g. `2026-11-09T09:00:00`), or null for a master. */
export const recurrenceId = (c: JCalComponent): string | null => text(c, "recurrence-id");

/** The UID, or null when the component has none. */
export const uidOf = (c: JCalComponent): string | null => text(c, "uid");

/** Every TZID referenced by the component's properties and sub-components. */
export function tzidsOf(c: JCalComponent): Set<string> {
  const out = new Set<string>();
  const walk = (comp: JCalComponent) => {
    for (const p of comp[1]) {
      const tzid = propParam(p, "tzid");
      if (tzid) out.add(tzid);
    }
    comp[2].forEach(walk);
  };
  walk(c);
  return out;
}

export const summary = (c: JCalComponent): string | null => text(c, "summary");
export const status = (c: JCalComponent): string | null => text(c, "status")?.toUpperCase() ?? null;
export const transp = (c: JCalComponent): "OPAQUE" | "TRANSPARENT" =>
  text(c, "transp")?.toUpperCase() === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE";
/** CLASS, defaulting to PUBLIC as RFC 5545 specifies. */
export const classification = (c: JCalComponent): string => text(c, "class")?.toUpperCase() ?? "PUBLIC";

/** SEQUENCE, defaulting to 0. */
export function sequence(c: JCalComponent): number {
  const v = firstValue(c, "sequence");
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** LAST-MODIFIED as an instant, or null when absent or not a UTC date-time. */
export function lastModified(c: JCalComponent): Temporal.Instant | null {
  const v = text(c, "last-modified");
  if (!v) return null;
  try {
    return Temporal.Instant.from(v);
  } catch {
    return null;
  }
}

export type CalAddress = { address: string; params: JCalParams };
const calAddress = (p: JCalProperty): CalAddress | null =>
  typeof p[3] === "string" ? { address: p[3], params: { ...p[1] } } : null;

export const organizer = (c: JCalComponent): CalAddress | null => {
  const p = getProp(c, "organizer");
  return p ? calAddress(p) : null;
};
export const attendees = (c: JCalComponent): CalAddress[] =>
  getProps(c, "attendee").flatMap((p) => calAddress(p) ?? []);

/**
 * Orders two copies of the same component: positive when `a` is the newer revision.
 * Higher SEQUENCE wins, then the later LAST-MODIFIED; 0 when neither decides.
 */
export function compareRevision(a: JCalComponent, b: JCalComponent): number {
  const seq = sequence(a) - sequence(b);
  if (seq !== 0) return seq;
  const la = lastModified(a);
  const lb = lastModified(b);
  if (la && lb) return Temporal.Instant.compare(la, lb);
  return la ? 1 : lb ? -1 : 0;
}

// JSON with object keys sorted, so parameter order does not count as a change.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** sha256 (hex) over a canonical serialisation of the resource; equal for equal content. */
export const revisionOf = (resource: EventResource): string =>
  createHash("sha256").update(canonical(resource)).digest("hex");
