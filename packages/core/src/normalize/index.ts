/**
 * Normalisers by `source_object.format`: the sync runner picks one per source calendar and calls it
 * with every object of a dirty group. `version` is stored on each normalised `source_object` row;
 * bumping it makes the daemon re-normalise older rows at boot. The `google` and `graph` providers
 * add their entries here.
 */
import type { EventResource } from "../model.ts";
import { normalizeIcal, type Completeness, type SourceObject } from "./ical.ts";

export const SOURCE_FORMATS = ["ical", "google", "graph"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export type Normalizer = {
  readonly version: number;
  normalize(objects: SourceObject[]): { resource: EventResource; completeness: Completeness };
};

export const normalizers: { readonly [F in SourceFormat]?: Normalizer } = {
  ical: { version: 1, normalize: normalizeIcal },
};
