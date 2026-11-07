/**
 * The event model. One `EventResource` per iCalendar UID holds the master and its overrides as
 * jCal (RFC 7265), so unknown and X- properties survive by construction. Only `accessors.ts`
 * indexes into these arrays.
 */
import type { Temporal } from "@js-temporal/polyfill";

/** A jCal value: scalars, structured values (arrays) and RECUR/GEO-style objects. */
export type JCalValue = string | number | boolean | null | JCalValue[] | { [key: string]: JCalValue };

export type JCalParams = Record<string, string | string[]>;
export type JCalProperty = [name: string, params: JCalParams, type: string, ...values: JCalValue[]];
export type JCalComponent = [name: string, properties: JCalProperty[], components: JCalComponent[]];

export type EventResource = {
  uid: string;
  /** VEVENT without RECURRENCE-ID; null if we only hold detached instances. */
  master: JCalComponent | null;
  /** VEVENTs with RECURRENCE-ID, sorted by recurrence id. */
  overrides: JCalComponent[];
  /** VTIMEZONE by TZID, as supplied or generated. */
  timezones: Record<string, JCalComponent>;
};

/** One expanded instance of a resource. `recurrenceId` is the original start as a jCal value. */
export type Occurrence = {
  recurrenceId: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
  allDay: boolean;
  component: JCalComponent;
};
