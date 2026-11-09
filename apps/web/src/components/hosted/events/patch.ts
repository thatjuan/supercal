/**
 * What a dashboard edit sends: PatchObjects with only what changed, so every property the form does
 * not show (X- properties, attendees, vendor fields) survives on the server. Never a `PUT`, which
 * would replace the event and lose them.
 */
import { Temporal } from '@js-temporal/polyfill';
import { eventFields, eventForm, type EventForm, type JSEvent } from './form.ts';

type Override = Record<string, unknown>;

/** The fields the form controls. Nothing else ever enters a patch: not `participants`, and not what the server sets. */
const CONTROLLED = ['title', 'start', 'duration', 'timeZone', 'endTimeZone', 'showWithoutTime', 'locations', 'mainLocationId', 'description', 'recurrenceRule', 'status', 'freeBusyStatus', 'privacy', 'alerts'] as const satisfies readonly (keyof JSEvent)[];

/** The server sets these. They can appear in an override as read, and are never sent back. */
const SERVER_SET = new Set(['updated', 'created', 'sequence', 'prodId']);

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(Reflect.get(a, key), Reflect.get(b, key)));
};

const withoutServerSet = (override: Override) => Object.fromEntries(Object.entries(override).filter(([key]) => !SERVER_SET.has(key)));

/**
 * The overrides of a series moved from `from` to `to`, under their new keys. An override's key is an
 * occurrence's wall-clock start, so a key left behind would stop matching: a deleted occurrence
 * would come back.
 */
function movedOverrides(overrides: Record<string, Override>, from: string, to: string) {
  const by = Temporal.PlainDateTime.from(from).until(to);
  return Object.fromEntries(Object.entries(overrides).map(([key, value]) => [Temporal.PlainDateTime.from(key).add(by).toString({ smallestUnit: 'second' }), withoutServerSet(value)]));
}

/**
 * The PatchObject that makes `before` match the form: top-level keys only, changed fields with their
 * new value, cleared fields as `null`. Both sides go through the form, so a value the form would
 * only write differently (`PT3600S` and `PT1H`) is not a change.
 */
export function eventPatch(before: JSEvent, after: EventForm): Record<string, unknown> {
  const was = eventFields(eventForm(before, after.zone), before);
  const now = eventFields(after, before);
  const wasFields: Partial<JSEvent> = was;
  const nowFields: Partial<JSEvent> = now;
  const patch: Record<string, unknown> = {};
  for (const key of CONTROLLED) {
    if (!same(wasFields[key], nowFields[key])) patch[key] = nowFields[key] ?? null;
  }
  if (patch.start !== undefined && before.recurrenceOverrides) patch.recurrenceOverrides = movedOverrides(before.recurrenceOverrides, before.start, now.start);
  return patch;
}

/** `recurrenceOverrides` key for an occurrence's `recurrenceId`. */
export const overrideKey = (recurrenceId: string) => {
  const bare = recurrenceId.replace(/Z$/, '');
  return bare.length === 10 ? `${bare}T00:00:00` : bare;
};

/** Sets one override. PatchObject rule 2 refuses a pointer into a map that does not exist yet. */
export const overridePatch = (event: JSEvent, key: string, value: Override) => (event.recurrenceOverrides ? { [`recurrenceOverrides/${key}`]: value } : { recurrenceOverrides: { [key]: value } });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Applies an override's PatchObject, as read from the API, to a copy of `event`. */
function withOverride(event: JSEvent, override: Override): JSEvent {
  const result = structuredClone(event);
  for (const [pointer, value] of Object.entries(override)) {
    const tokens = pointer.split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = tokens.pop();
    let target: unknown = result;
    for (const token of tokens) target = isRecord(target) && Object.hasOwn(target, token) ? target[token] : undefined;
    if (!isRecord(target) || last === undefined) continue;
    if (value === null) Reflect.deleteProperty(target, last);
    else target[last] = value;
  }
  return result;
}

/** One occurrence as it stands: the series at `key`, with its override applied. It has no rule, and the form hides what an override cannot hold. */
export function occurrenceEvent(event: JSEvent, key: string): JSEvent {
  const { recurrenceRule: _rule, recurrenceOverrides: overrides, ...series } = event;
  return withOverride({ ...series, start: key }, overrides?.[key] ?? {});
}

/** The occurrence at `key` as the start of a new series, with the overrides that series would keep. */
export function followingEvent(event: JSEvent, key: string): JSEvent {
  const later = Object.fromEntries(Object.entries(event.recurrenceOverrides ?? {}).filter(([date]) => date >= key));
  return {
    ...occurrenceEvent(event, key),
    ...(event.recurrenceRule && { recurrenceRule: event.recurrenceRule }),
    ...(Object.keys(later).length > 0 && { recurrenceOverrides: later }),
  };
}

/**
 * The patch that edits only the occurrence at `key`. Its override starts from the existing one, so
 * earlier changes survive, and holds only what differs from the series. Empty when nothing changed;
 * an override left with no differences is removed, because an empty one would mean an extra date.
 */
export function occurrencePatch(event: JSEvent, key: string, after: EventForm): Record<string, unknown> {
  const changes = eventPatch(occurrenceEvent(event, key), after);
  if (Object.keys(changes).length === 0) return {};
  const series: Override = { ...event, start: key };
  const value = withoutServerSet(event.recurrenceOverrides?.[key] ?? {});
  for (const [field, changed] of Object.entries(changes)) {
    // A top-level value replaces any pointers below it; the two together are not a valid patch.
    for (const pointer of Object.keys(value)) if (pointer.startsWith(`${field}/`)) Reflect.deleteProperty(value, pointer);
    if (same(changed ?? undefined, series[field])) Reflect.deleteProperty(value, field);
    else value[field] = changed;
  }
  return Object.keys(value).length > 0 ? overridePatch(event, key, value) : { [`recurrenceOverrides/${key}`]: null };
}

/** "This and following" splits the series, which the API refuses at the first occurrence: there it is the same as "All events". */
export const canSplit = (event: JSEvent, key: string) => event.recurrenceRule !== undefined && Temporal.PlainDateTime.compare(key, event.start) > 0;
