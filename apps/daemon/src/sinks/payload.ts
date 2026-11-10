/**
 * Google event bodies for a projected object (architecture §11, ingest FINDINGS §6). The master
 * carries the `recurrence[]` lines; each override is its own event with `recurringEventId` and
 * `originalStartTime` (standalone when there is no master). Bodies never carry attendees, an
 * organizer or conference data, so a mirrored item is an appointment that invites nobody; an
 * existing join URL goes into the description. Ids are deterministic, so retries are idempotent.
 *
 *   const { revision, events } = googleEvents(sinkId, object, 'Europe/Paris');
 */
import { createHash } from 'node:crypto';
import {
  googleTime,
  googleEndTime,
  type GoogleTime,
  classification,
  getProp,
  getProps,
  propertyLine,
  recurrenceId,
  status,
  textValue,
  transp,
  type EventResource,
  type JCalComponent,
  type ProjectedObject,
} from '@supercal/core';

export type { GoogleTime } from '@supercal/core';

/** Everything a sink sends for one event. The type has no attendee, organizer or conference fields on purpose. */
export type SinkEventBody = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GoogleTime;
  end: GoogleTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
  status: 'confirmed' | 'tentative' | 'cancelled';
  transparency: 'opaque' | 'transparent';
  visibility?: 'private' | 'confidential';
  reminders: { useDefault: false };
  extendedProperties: { private: { supercalSink: string; supercalUid: string; supercalRevision: string } };
};

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

function base32hex(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32HEX[(value << (5 - bits)) & 31] : out;
}

/**
 * The Google event id of one component: `base32hex(sha256(sinkId, uid, recurrenceId))[:26]`, which
 * meets Google's id rules (base32hex characters, 5–1024 long). `recurrenceId` is '' for a master.
 */
export const sinkEventId = (sinkId: string, uid: string, recurrence: string): string =>
  base32hex(createHash('sha256').update(`${sinkId}\0${uid}\0${recurrence}`).digest()).slice(0, 26).toLowerCase();

/** The first join URL of a component (CONFERENCE, else URL), for the description. */
function joinUrl(component: JCalComponent): string | null {
  for (const name of ['conference', 'url']) {
    const value = textValue(component, name);
    if (value && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

const STATUS = { CANCELLED: 'cancelled', TENTATIVE: 'tentative' } as const;
const VISIBILITY = { PRIVATE: 'private', CONFIDENTIAL: 'confidential' } as const;

type Unrevised = Omit<SinkEventBody, 'extendedProperties'>;

function body(id: string, component: JCalComponent, resource: EventResource, zone: string): Unrevised {
  const dtstart = getProp(component, 'dtstart');
  if (!dtstart) throw new RangeError(`a component of ${resource.uid} has no DTSTART`);
  const start = googleTime(dtstart, resource, zone);
  const summary = textValue(component, 'summary');
  const location = textValue(component, 'location');
  const url = joinUrl(component);
  const text = textValue(component, 'description');
  const description = url && !text?.includes(url) ? [text, `Join: ${url}`].filter(Boolean).join('\n\n') : text;
  const visibility = VISIBILITY[classification(component) as keyof typeof VISIBILITY];
  return {
    id,
    ...(summary !== null && { summary }),
    ...(description !== null && { description }),
    ...(location !== null && { location }),
    start,
    end: googleEndTime(component, start, resource, zone),
    status: STATUS[status(component) as keyof typeof STATUS] ?? 'confirmed',
    transparency: transp(component) === 'TRANSPARENT' ? 'transparent' : 'opaque',
    ...(visibility && { visibility }),
    reminders: { useDefault: false },
  };
}

/**
 * Every Google event for `object` (master first, then overrides) and the revision they share: a
 * hash of the bodies themselves, so anything that changes what is sent (projection, mapping, the
 * sink's zone) is a real difference and nothing else is. `zone` reads floating times.
 */
export function googleEvents(sinkId: string, object: ProjectedObject, zone: string): { revision: string; events: SinkEventBody[] } {
  const { resource } = object;
  const { master } = resource;
  const uid = object.outputUid;
  const masterId = sinkEventId(sinkId, uid, '');
  const bodies: Unrevised[] = [];
  if (master) {
    const recurrence = ['rrule', 'rdate', 'exdate'].flatMap((name) => getProps(master, name)).map(propertyLine);
    bodies.push({ ...body(masterId, master, resource, zone), ...(recurrence.length > 0 && { recurrence }) });
  }
  for (const override of resource.overrides) {
    const slot = getProp(override, 'recurrence-id');
    if (!slot) continue;
    const own = body(sinkEventId(sinkId, uid, recurrenceId(override) ?? ''), override, resource, zone);
    bodies.push(master ? { ...own, recurringEventId: masterId, originalStartTime: googleTime(slot, resource, zone) } : own);
  }
  const revision = createHash('sha256').update(JSON.stringify(bodies)).digest('base64url').slice(0, 27);
  return {
    revision,
    events: bodies.map((b) => ({ ...b, extendedProperties: { private: { supercalSink: sinkId, supercalUid: uid, supercalRevision: revision } } })),
  };
}
