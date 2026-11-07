import ICAL from 'ical.js';
import { createHash } from 'node:crypto';
import { guardedRequest, type GuardOptions } from './ssrf';
export type IcsResource = { id: string; uid: string; revision: string; ical: string };
export type IcsCursor = { etag?: string; lastModified?: string; hashes: Record<string, string> };
/** Group masters and detached overrides by UID, carrying VTIMEZONE definitions into each resource. */
export function parseResources(text: string): IcsResource[] {
  if (!text.trimStart().startsWith('BEGIN:VCALENDAR')) throw new Error('Not an iCalendar document');
  const calendar = new ICAL.Component(ICAL.parse(text));
  if (calendar.name !== 'vcalendar' || calendar.getFirstPropertyValue('version') !== '2.0') throw new Error('Invalid VCALENDAR');
  const groups = new Map<string, ICAL.Component[]>();
  for (const event of calendar.getAllSubcomponents('vevent')) {
    const uid = event.getFirstPropertyValue('uid'); if (typeof uid !== 'string' || !uid) throw new Error('VEVENT missing UID');
    const group = groups.get(uid) ?? []; group.push(event); groups.set(uid, group);
  }
  return [...groups].map(([uid, events]) => {
    const out = new ICAL.Component('vcalendar'); out.addPropertyWithValue('version', '2.0'); out.addPropertyWithValue('prodid', '-//Supercal//Ingest Spike//EN');
    for (const zone of calendar.getAllSubcomponents('vtimezone')) out.addSubcomponent(new ICAL.Component(zone.toJSON()));
    for (const event of events) out.addSubcomponent(new ICAL.Component(event.toJSON()));
    const ical = out.toString(); return { id: uid, uid, ical, revision: createHash('sha256').update(ical).digest('hex') };
  });
}
export async function syncIcs(url: string, cursor?: IcsCursor, options: GuardOptions = {}) {
  const headers: Record<string, string> = {};
  if (cursor?.etag) headers['If-None-Match'] = cursor.etag;
  if (cursor?.lastModified) headers['If-Modified-Since'] = cursor.lastModified;
  const r = await guardedRequest(url, { headers }, options);
  if (r.status === 304 && cursor) return { upserts: [] as IcsResource[], deletes: [] as string[], nextCursor: cursor, fullResync: false };
  if (r.status !== 200) throw new Error(`ICS HTTP ${r.status}`);
  const resources = parseResources(r.text); // MIME is advisory: real providers return text/plain or octet-stream.
  const hashes = Object.fromEntries(resources.map(o => [o.id, o.revision]));
  return { upserts: resources.filter(o => cursor?.hashes[o.id] !== o.revision), deletes: Object.keys(cursor?.hashes ?? {}).filter(id => !(id in hashes)),
    fullResync: !cursor, nextCursor: { etag: r.headers.get('etag') ?? undefined, lastModified: r.headers.get('last-modified') ?? undefined, hashes } };
}
