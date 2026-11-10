/**
 * Normalisers by `source_object.format`: the sync runner picks one per source calendar and calls it
 * with every object of a dirty group. `version` is stored on each normalised `source_object` row;
 * bumping it makes the daemon re-normalise older rows at boot. Version 2 recomputes spans resolved
 * under stale tzdata (BC's permanent UTC-7 from 2026-11); spans are part of the no-op check. Google version 3 retains explicit reminders for device editing. `normalize` returns null when the
 * group publishes nothing (e.g. a cancelled Google master), which the runner turns into a delete.
 */
import type { EventResource } from "../model.ts";
import { normalizeGoogle } from "./google.ts";
import { normalizeGraph } from "./graph.ts";
import { normalizeIcal, type Completeness, type SourceObject } from "./ical.ts";

export const SOURCE_FORMATS = ["ical", "google", "graph"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export type Normalizer = {
  readonly version: number;
  normalize(objects: SourceObject[]): { resource: EventResource; completeness: Completeness } | null;
};

export const normalizers: { readonly [F in SourceFormat]?: Normalizer } = {
  ical: { version: 2, normalize: normalizeIcal },
  google: { version: 3, normalize: normalizeGoogle },
  graph: { version: 2, normalize: normalizeGraph },
};
