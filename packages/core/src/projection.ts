/**
 * Publication projection (docs/architecture.md §5): turns the stored resources of a publication's
 * source calendars into the exact iCalendar objects a client receives. Per source UID, in order:
 * merge copies, apply filters, apply privacy by allowlist, rewrite the UID, derive the href.
 * Inputs are never mutated and outputs share no structure with them. Pure apart from WebCrypto,
 * which makes the hashing functions async.
 */
import { Temporal } from "@js-temporal/polyfill";
import {
  classification,
  componentName,
  getProp,
  getProps,
  lastModified,
  organizer,
  propName,
  propParam,
  propType,
  propValues,
  properties,
  recurrenceId,
  sequence,
  setProp,
  status,
  subcomponents,
  summary,
  textValue,
  transp,
  tzidsOf,
} from "./accessors.ts";
import { componentsOf } from "./ical.ts";
import type { EventResource, JCalComponent, JCalParams, JCalProperty } from "./model.ts";

/**
 * Version of the projected output. Bump it with any change that alters what `project` or
 * `serializeCalendar` emit for unchanged inputs (allowlists, filters, UID or href derivation,
 * serialisation). It is part of every object and ICS ETag, so bumping it makes clients
 * re-download; forgetting to bump leaves them holding stale bodies under unchanged ETags.
 */
export const RENDER_VERSION = 1;

export type Privacy = "full" | "title-only" | "busy-only";

export type PublicationSpec = {
  /** `pub_…` TypeID. */
  id: string;
  kind: "passthrough" | "virtual";
  privacy: Privacy;
  filters: { hideDeclined: boolean; hideCancelled: boolean; hideAllDay: boolean };
  keepAlarms: boolean;
  /** `mailto:` addresses of the account owners, for the declined filter. The organizer rule uses `SourceResource.ownerAddresses`. */
  ownerAddresses: string[];
  /** HMAC key (`feed.uid_secret`) for title-only and busy-only UIDs. */
  uidSecret: CryptoKey;
};

export type SourceResource = {
  sourceCalendarId: string;
  /** Lower wins the last merge tie-break. */
  priority: number;
  /** `mailto:` addresses that own this source calendar's account: a copy organized by one of them is the organizer's copy. */
  ownerAddresses: string[];
  resource: EventResource;
};

export type ProjectedObject = { outputUid: string; href: string; resource: EventResource; sourceUid: string };

type UidSpec = Pick<PublicationSpec, "id" | "kind" | "privacy" | "uidSecret">;

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bareAddress = (address: string) => address.trim().toLowerCase().replace(/^mailto:/, "");

// 1. Merge

type Candidate = { component: JCalComponent; from: SourceResource };

const isOrganizerCopy = ({ component, from }: Candidate) => {
  const org = organizer(component);
  return org !== null && from.ownerAddresses.some((a) => bareAddress(a) === bareAddress(org.address));
};

// LAST-MODIFIED, else DTSTAMP, as epoch milliseconds; 0 when neither parses.
function modifiedAt(c: JCalComponent): number {
  const lm = lastModified(c);
  if (lm) return lm.epochMilliseconds;
  try {
    return Temporal.Instant.from(textValue(c, "dtstamp") ?? "").epochMilliseconds;
  } catch {
    return 0;
  }
}

// Positive when `a` beats `b`: organizer's copy, higher SEQUENCE, later LAST-MODIFIED/DTSTAMP,
// lower priority, then lower source id so the result never depends on input order.
const precedence = (a: Candidate, b: Candidate): number =>
  Number(isOrganizerCopy(a)) - Number(isOrganizerCopy(b)) ||
  sequence(a.component) - sequence(b.component) ||
  modifiedAt(a.component) - modifiedAt(b.component) ||
  b.from.priority - a.from.priority ||
  compareStrings(b.from.sourceCalendarId, a.from.sourceCalendarId);

/** One resource from every copy of a UID: a winner per component, overrides unioned. */
function merge(uid: string, copies: SourceResource[]): EventResource {
  const winners = new Map<string | null, Candidate>();
  for (const from of copies)
    for (const component of componentsOf(from.resource)) {
      const key = recurrenceId(component);
      const current = winners.get(key);
      const candidate = { component, from };
      if (!current || precedence(candidate, current) > 0) winners.set(key, candidate);
    }
  const master = winners.get(null) ?? null;
  const overrides = [...winners]
    .flatMap(([key, w]) => (key === null ? [] : [[key, w] as const]))
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, w]) => w);
  // Each component brings the VTIMEZONEs of the source it came from.
  const timezones: EventResource["timezones"] = {};
  for (const { component, from } of master ? [master, ...overrides] : overrides)
    for (const tzid of tzidsOf(component)) {
      const tz = from.resource.timezones[tzid];
      if (tz) timezones[tzid] ??= tz;
    }
  return { uid, master: master?.component ?? null, overrides: overrides.map((w) => w.component), timezones };
}

// 2–3. Filters and privacy

const PRIVATE_CLASSES = new Set(["PRIVATE", "CONFIDENTIAL"]);
const effectivePrivacy = (privacy: Privacy, c: JCalComponent): Privacy =>
  privacy === "title-only" && PRIVATE_CLASSES.has(classification(c)) ? "busy-only" : privacy;

function declinedByOwner(spec: PublicationSpec, c: JCalComponent): boolean {
  const owners = new Set(spec.ownerAddresses.map(bareAddress));
  return getProps(c, "attendee").some((p) => {
    const address = propValues(p)[0];
    return typeof address === "string" && owners.has(bareAddress(address)) && propParam(p, "partstat")?.toUpperCase() === "DECLINED";
  });
}

const isAllDay = (c: JCalComponent) => {
  const dtstart = getProp(c, "dtstart");
  return dtstart !== undefined && propType(dtstart) === "date";
};

/** Hidden by a filter, or free time (TRANSP:TRANSPARENT) in busy-only output. */
function isHidden(spec: PublicationSpec, c: JCalComponent): boolean {
  const { hideCancelled, hideDeclined, hideAllDay } = spec.filters;
  return (
    (hideCancelled && status(c) === "CANCELLED") ||
    (hideDeclined && declinedByOwner(spec, c)) ||
    (hideAllDay && isAllDay(c)) ||
    (effectivePrivacy(spec.privacy, c) === "busy-only" && transp(c) === "TRANSPARENT")
  );
}

/** EXDATE for an override's RECURRENCE-ID, so hiding the override does not revive the master's instance. */
function exdateFor(override: JCalComponent): JCalProperty[] {
  const rid = getProp(override, "recurrence-id");
  if (!rid) return [];
  const tzid = propParam(rid, "tzid");
  return [["exdate", tzid ? { tzid } : {}, propType(rid), ...propValues(rid)]];
}

const BUSY_PROPS = new Set(["uid", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate", "recurrence-id", "status", "transp"]);
const TITLE_PROPS = new Set([...BUSY_PROPS, "summary", "color"]);
// Parameters that survive on allowlisted properties; anything else (X- params, ALTREP) could leak.
const KEPT_PARAMS = ["tzid", "range"] as const;
const BUSY_SUMMARY: JCalProperty = ["summary", {}, "text", "Busy"];
/** DTSTAMP of title-only and busy-only output: RFC 5545 requires one, and a constant leaks no edit time. */
export const BUSY_DTSTAMP = "1970-01-01T00:00:00Z";

function allowedParams(p: JCalProperty): JCalProperty {
  const params: JCalParams = {};
  for (const name of KEPT_PARAMS) {
    const v = propParam(p, name);
    if (v !== undefined) params[name] = v;
  }
  return [propName(p), params, propType(p), ...structuredClone(propValues(p))];
}

/**
 * A new component holding only what `privacy` allows; built up from allowlisted properties,
 * never by deleting from a copy. Full keeps everything (VALARM only with `keepAlarms`).
 */
function applyPrivacy(spec: PublicationSpec, c: JCalComponent): JCalComponent {
  const mode = effectivePrivacy(spec.privacy, c);
  if (mode === "full") {
    const subs = subcomponents(c).filter((s) => spec.keepAlarms || componentName(s) !== "valarm");
    return structuredClone([componentName(c), properties(c), subs]);
  }
  const allow = mode === "title-only" ? TITLE_PROPS : BUSY_PROPS;
  const kept: JCalComponent = [componentName(c), properties(c).filter((p) => allow.has(propName(p))).map(allowedParams), []];
  const stamped = setProp(kept, ["dtstamp", {}, "date-time", BUSY_DTSTAMP]);
  return mode === "title-only" && summary(c) !== null ? stamped : setProp(stamped, BUSY_SUMMARY);
}

/** Filters and privacy for one merged resource; null when nothing of it is visible. */
function visible(spec: PublicationSpec, merged: EventResource): EventResource | null {
  const { master } = merged;
  if (master && isHidden(spec, master)) return null;
  const overrides = merged.overrides.filter((o) => !isHidden(spec, o));
  if (!master && !overrides.length) return null;
  const exdates = merged.overrides.filter((o) => isHidden(spec, o)).flatMap(exdateFor);
  const withExdates: JCalComponent | null =
    master && exdates.length ? [componentName(master), [...properties(master), ...exdates], subcomponents(master)] : master;
  const projected = {
    master: withExdates && applyPrivacy(spec, withExdates),
    overrides: overrides.map((o) => applyPrivacy(spec, o)),
  };
  const used = new Set([projected.master, ...projected.overrides].flatMap((c) => (c ? [...tzidsOf(c)] : [])));
  const timezones = Object.fromEntries(
    Object.entries(merged.timezones).flatMap(([id, tz]) => (used.has(id) ? [[id, structuredClone(tz)] as const] : [])),
  );
  return { uid: merged.uid, ...projected, timezones };
}

// 4–5. UIDs, hrefs and ETags

const encoder = new TextEncoder();
const b64url = (digest: ArrayBuffer) => Buffer.from(digest).toString("base64url");
const sha256 = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
const hmacSha256 = async (key: CryptoKey, s: string) => b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(s)));

/**
 * The UID clients see. Passthrough + full keeps the source UID; virtual + full hashes it with the
 * publication id; title-only and busy-only use an HMAC so the source UID cannot be recovered.
 */
async function outputUidFor(spec: UidSpec, sourceUid: string): Promise<string> {
  if (spec.privacy === "full" && spec.kind === "passthrough") return sourceUid;
  const input = `${spec.id}\u0000${sourceUid}`;
  const digest = spec.privacy === "full" ? await sha256(input) : await hmacSha256(spec.uidSecret, input);
  return `${digest.slice(0, 26)}@supercal`;
}

const hrefOf = async (outputUid: string) => `${(await sha256(outputUid)).slice(0, 22)}.ics`;

/** The object href for a source UID, without projecting. The CalDAV server resolves hrefs with it. */
export const hrefFor = async (spec: UidSpec, sourceUid: string): Promise<string> => hrefOf(await outputUidFor(spec, sourceUid));

/**
 * The quoted ETag of one CalDAV object, derived without rendering so etag listings stay cheap.
 * `maxSeq` is the highest `seq` over the UID's copies. Name and colour are deliberately not inputs,
 * so a rename does not change ETags.
 */
export async function objectEtag(spec: Pick<PublicationSpec, "id">, epoch: number, uid: string, maxSeq: number | bigint): Promise<string> {
  return `"${(await sha256([spec.id, epoch, uid, maxSeq, RENDER_VERSION].join("|"))).slice(0, 27)}"`;
}

const withUid = (c: JCalComponent, uid: string) => setProp(c, ["uid", {}, "text", uid]);

/**
 * Projects a publication: one object per visible source UID, sorted by source UID, so the result
 * does not depend on input order. Copies of a UID from several sources (virtual publications)
 * are merged per component; see `precedence`.
 */
export async function project(spec: PublicationSpec, inputs: SourceResource[]): Promise<ProjectedObject[]> {
  const groups = new Map<string, SourceResource[]>();
  for (const input of inputs) groups.set(input.resource.uid, [...(groups.get(input.resource.uid) ?? []), input]);
  const objects = await Promise.all(
    [...groups]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(async ([sourceUid, copies]): Promise<ProjectedObject | null> => {
        const resource = visible(spec, merge(sourceUid, copies));
        if (!resource) return null;
        const outputUid = await outputUidFor(spec, sourceUid);
        return {
          outputUid,
          href: await hrefOf(outputUid),
          sourceUid,
          resource: {
            uid: outputUid,
            master: resource.master && withUid(resource.master, outputUid),
            overrides: resource.overrides.map((o) => withUid(o, outputUid)),
            timezones: resource.timezones,
          },
        };
      }),
  );
  return objects.filter((o) => o !== null);
}

/**
 * Projects the publications of a combined feed (`all.ics`) and dedupes by source UID. The first
 * publication by `sortOrder` (then id) whose inputs contain a UID claims it, and only its
 * projection applies, even when that projection hides the event: a UID hidden by an earlier
 * publication never resurfaces through a laxer one. Copies are not merged across publications.
 */
export async function projectCombined(
  publications: { spec: PublicationSpec; sortOrder: number; inputs: SourceResource[] }[],
): Promise<ProjectedObject[]> {
  const ordered = [...publications].sort((a, b) => a.sortOrder - b.sortOrder || compareStrings(a.spec.id, b.spec.id));
  const claimed = new Set<string>();
  const out: ProjectedObject[] = [];
  for (const { spec, inputs } of ordered) {
    const unclaimed = inputs.filter((i) => !claimed.has(i.resource.uid));
    for (const i of unclaimed) claimed.add(i.resource.uid);
    out.push(...(await project(spec, unclaimed)));
  }
  return out;
}
