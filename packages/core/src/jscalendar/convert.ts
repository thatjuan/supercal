import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import { getProp, getProps, propName, propParam, propParams, propType, propValues, properties, recurrenceId, removeProps, replaceProperties, replaceSubcomponents, setProp, subcomponents, textValue } from '../accessors.ts';
import { expandOccurrences, assertIanaZone } from '../time.ts';
import { addMissingTimezones } from '../vtimezone.ts';
import type { EventResource, JCalComponent, JCalParams, JCalProperty, JCalValue } from '../model.ts';
import { applyPatch, diffObjects, escapePointer, InvalidPatchError, pointerTokens } from './patch.ts';
import { JSEvent, type JSGroup, type PatchObject } from './schema.ts';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fmt = (v: Temporal.PlainDateTime) => v.toString({ smallestUnit: 'second' });
const local = (v: string) => v.length === 10 ? `${v}T00:00:00` : v.replace(/Z$/, '');
const value = (p: JCalProperty) => propValues(p)[0];
const idOf = (p: JCalProperty, i: number) => propParam(p, 'jsid') ?? String(i + 1);
const componentId = (c: JCalComponent, i: number) => textValue(c, 'jsid') ?? String(i + 1);
const p = (name: string, v: JCalValue, type = 'text', params: JCalParams = {}): JCalProperty => [name, params, type, v];
const scalar = {
  uid: 'uid', title: 'summary', description: 'description', color: 'color', priority: 'priority', sequence: 'sequence',
  created: 'created', updated: 'last-modified', organizerCalendarAddress: 'organizer',
} as const;
const ruleKeys = {
  frequency: 'freq', interval: 'interval', count: 'count', until: 'until', firstDayOfWeek: 'wkst', rscale: 'rscale', skip: 'skip',
  byDay: 'byday', byMonth: 'bymonth', byMonthDay: 'bymonthday', byYearDay: 'byyearday', byWeekNo: 'byweekno', byHour: 'byhour', byMinute: 'byminute', bySecond: 'bysecond', bySetPosition: 'bysetpos',
} as const;
const participantParams = { name: 'cn', email: 'email', kind: 'cutype', participationStatus: 'partstat', expectReply: 'rsvp' } as const;
const forbiddenOverride = new Set(['@type', 'uid', 'prodId', 'method', 'organizerCalendarAddress', 'sentBy', 'recurrenceId', 'recurrenceIdTimeZone', 'recurrenceRule', 'recurrenceOverrides', 'privacy']);
function invalidOverridePointer(pointer: string): boolean {
  const tokens = pointerTokens(pointer);
  return ['recurrenceRule', 'recurrenceOverrides'].includes(tokens[0]!) || (tokens.length === 1 && forbiddenOverride.has(tokens[0]!)) || (tokens.length === 3 && tokens[0] === 'participants' && tokens[2] === 'calendarAddress');
}

/** Converts an iCalendar temporal value to the event's wall time, including UTC EXDATEs. */
function wallIn(v: string, zone?: string, sourceZone?: string): string {
  if (v.endsWith('Z') && zone) return fmt(Temporal.Instant.from(v).toZonedDateTimeISO(zone).toPlainDateTime());
  if (sourceZone && zone && sourceZone !== zone) {
    try { return fmt(Temporal.PlainDateTime.from(local(v)).toZonedDateTime(sourceZone).withTimeZone(zone).toPlainDateTime()); } catch { /* Non-IANA source zones have no JSCalendar timeZone. */ }
  }
  return local(v);
}

function readRule(comp: JCalComponent, zone?: string): Record<string, unknown> | undefined {
  const raw = getProp(comp, 'rrule');
  const v = raw && value(raw);
  if (!record(v)) return;
  const out: Record<string, unknown> = {};
  for (const [js, ical] of Object.entries(ruleKeys)) {
    let x = v[ical];
    if (x === undefined) continue;
    if (js === 'until' && typeof x === 'string') x = wallIn(x, zone);
    else if (js === 'byDay') x = (Array.isArray(x) ? x : [x]).map((d) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/i.exec(String(d));
      return { day: (m?.[2] ?? String(d)).toLowerCase(), ...(m?.[1] && { nthOfPeriod: Number(m[1]) }) };
    });
    else if (js.startsWith('by')) x = (Array.isArray(x) ? x : [x]).map((n) => js === 'byMonth' ? String(n) : Number(n));
    else if (typeof x === 'string') x = x.toLowerCase();
    out[js] = x;
  }
  return out;
}

function readLinks(comp: JCalComponent): Record<string, Record<string, unknown>> {
  const links: Record<string, Record<string, unknown>> = {};
  for (const name of ['attach', 'image', 'url', 'link']) for (const [i, property] of getProps(comp, name).entries()) {
    const params = propParams(property);
    const entry: Record<string, unknown> = { href: propType(property) === 'binary' ? `data:${params.fmttype ?? 'application/octet-stream'};base64,${value(property)}` : value(property) };
    const rel = name === 'attach' ? 'enclosure' : name === 'image' ? 'icon' : name === 'url' ? 'describedby' : propParam(property, 'linkrel');
    if (rel) entry.rel = rel;
    for (const [js, parameter] of [['title', name === 'attach' || name === 'image' ? 'filename' : 'label'], ['contentType', 'fmttype'], ['size', 'size'], ['display', 'display']] as const) {
      const v = propParam(property, parameter); if (v !== undefined) entry[js] = js === 'size' ? Number(v) : v;
    }
    links[propParam(property, 'jsid') ?? `${name}-${i + 1}`] = entry;
  }
  return links;
}
function writeLinks(links: JSEvent['links']): JCalProperty[] {
  let hasUrl = false;
  return Object.entries(links ?? {}).map(([id, link]) => {
    const name = link.rel === 'enclosure' ? 'attach' : link.rel === 'icon' ? 'image' : link.rel === 'describedby' && !hasUrl ? 'url' : 'link';
    if (name === 'url') hasUrl = true;
    const params: JCalParams = { jsid: id };
    for (const [js, parameter] of [['title', name === 'attach' || name === 'image' ? 'filename' : 'label'], ['contentType', 'fmttype'], ['size', 'size'], ['display', 'display']] as const) {
      if (link[js] !== undefined) params[parameter] = String(link[js]);
    }
    if (name === 'link' && link.rel !== undefined) params.linkrel = link.rel;
    return p(name, link.href, 'uri', params);
  });
}
function readComponent(comp: JCalComponent, resource: EventResource): JSEvent {
  const out: Record<string, unknown> = { '@type': 'Event', version: '2.0' };
  for (const [js, name] of Object.entries(scalar)) {
    const property = getProp(comp, name);
    if (property) out[js] = value(property);
  }
  out.uid ??= resource.uid;
  if (!out.updated && textValue(comp, 'dtstamp')) out.updated = textValue(comp, 'dtstamp');
  const start = getProp(comp, 'dtstart') ?? getProp(comp, 'recurrence-id');
  const startValue = start && value(start);
  if (typeof startValue === 'string') {
    out.start = local(startValue);
    const tzid = propParam(start!, 'tzid') ?? (startValue.endsWith('Z') ? 'Etc/UTC' : undefined);
    if (tzid) { try { assertIanaZone(tzid); out.timeZone = tzid; } catch { /* Custom source VTIMEZONEs cannot be expressed in JSCalendar 2.0. */ } }
    if (propType(start!) === 'date') out.showWithoutTime = true;
  }
  if (textValue(comp, 'show-without-time')?.toUpperCase() === 'TRUE' || valueOrUndefined(comp, 'show-without-time') === true) out.showWithoutTime = true;
  const zone = typeof out.timeZone === 'string' ? out.timeZone : undefined;
  const duration = textValue(comp, 'duration');
  const end = getProp(comp, 'dtend');
  if (end && typeof startValue === 'string') {
    // Expansion already implements nominal day durations, custom zones and differing DTEND zones.
    const single: EventResource = { ...resource, master: removeProps(comp, ['rrule', 'rdate', 'exdate', 'recurrence-id']), overrides: [] };
    const occurrence = expandOccurrences(single, { from: Temporal.Instant.from('0001-01-01T00:00:00Z'), to: Temporal.Instant.from('9999-12-31T00:00:00Z') }, 'UTC', 1).occurrences[0];
    if (occurrence) out.duration = propType(start!) === 'date'
      ? Temporal.PlainDate.from(startValue).until(Temporal.PlainDate.from(String(value(end)))) .toString()
      : Temporal.Duration.from({ seconds: (occurrence.end.epochMilliseconds - occurrence.start.epochMilliseconds) / 1000 }).round({ largestUnit: 'hour' }).toString();
    const endZone = propParam(end, 'tzid') ?? (String(value(end)).endsWith('Z') ? 'Etc/UTC' : undefined);
    if (zone && endZone && endZone !== zone) { try { assertIanaZone(endZone); out.endTimeZone = endZone; } catch {} }
  } else if (duration) out.duration = duration;
  else if (start && propType(start) === 'date') out.duration = 'P1D';
  const state = textValue(comp, 'status')?.toLowerCase();
  if (state && ['confirmed', 'tentative', 'cancelled'].includes(state)) out.status = state;
  if (getProp(comp, 'transp')) out.freeBusyStatus = textValue(comp, 'transp')?.toUpperCase() === 'TRANSPARENT' ? 'free' : 'busy';
  const privacy = textValue(comp, 'class')?.toUpperCase();
  if (privacy) out.privacy = privacy === 'PUBLIC' ? 'public' : privacy === 'CONFIDENTIAL' ? 'secret' : 'private';
  const keywords = getProps(comp, 'categories').flatMap(propValues).filter((v): v is string => typeof v === 'string');
  if (keywords.length) out.keywords = Object.fromEntries(keywords.map((v) => [v, true]));
  const locale = getProp(comp, 'summary');
  if (locale && propParam(locale, 'language')) out.locale = propParam(locale, 'language');
  const rule = readRule(comp, zone);
  if (rule) out.recurrenceRule = rule;
  const rid = recurrenceId(comp);
  if (rid) { out.recurrenceId = wallIn(rid, zone); if (zone) out.recurrenceIdTimeZone = zone; }

  const locations: Record<string, Record<string, unknown>> = {};
  for (const [i, child] of subcomponents(comp, 'vlocation').entries()) {
    const entry: Record<string, unknown> = {};
    for (const [js, name] of [['name', 'name'], ['description', 'description'], ['coordinates', 'coordinates']] as const) {
      const v = textValue(child, name); if (v !== null) entry[js] = v;
    }
    const types = getProps(child, 'location-type').flatMap(propValues).filter((v): v is string => typeof v === 'string');
    if (types.length) entry.locationTypes = Object.fromEntries(types.map((v) => [v, true]));
    locations[componentId(child, i)] = entry;
  }
  for (const [i, location] of getProps(comp, 'location').entries()) {
    const id = idOf(location, i);
    if (propParam(location, 'derived')?.toUpperCase() !== 'TRUE') locations[id] = { name: value(location) };
    if (Object.keys(locations).length > 1 || propParam(location, 'derived')?.toUpperCase() === 'TRUE') out.mainLocationId = id;
  }
  if (Object.keys(locations).length) out.locations = locations;
  const virtual = getProps(comp, 'conference');
  if (virtual.length) out.virtualLocations = Object.fromEntries(virtual.map((property, i) => [idOf(property, i), { uri: value(property), ...(propParam(property, 'label') && { name: propParam(property, 'label') }), ...(propParam(property, 'feature') && { features: Object.fromEntries(propParam(property, 'feature')!.split(',').map((feature) => [feature.toLowerCase(), true])) }) }]));
  const links = readLinks(comp);
  if (Object.keys(links).length) out.links = links;
  const participants = getProps(comp, 'attendee');
  if (participants.length) out.participants = Object.fromEntries(participants.map((property, i) => {
    const entry: Record<string, unknown> = { calendarAddress: value(property) };
    for (const [js, name] of Object.entries(participantParams)) {
      const v = propParam(property, name); if (v !== undefined) entry[js] = js === 'expectReply' ? v.toUpperCase() === 'TRUE' : ['kind', 'participationStatus'].includes(js) ? v.toLowerCase() : v;
    }
    const role = propParam(property, 'role');
    if (role) entry.roles = Object.fromEntries(role.split(',').map((v) => [{ CHAIR: 'chair', OWNER: 'owner', 'OPT-PARTICIPANT': 'optional', 'REQ-PARTICIPANT': 'attendee', 'NON-PARTICIPANT': 'informational' }[v.toUpperCase()] ?? v.toLowerCase(), true]));
    if (entry.kind === 'room') entry.kind = 'location';
    for (const [js, name] of [['delegatedTo', 'delegated-to'], ['delegatedFrom', 'delegated-from'], ['memberOf', 'member']] as const) {
      const addresses = propParam(property, name)?.split(',');
      if (addresses?.length) entry[js] = Object.fromEntries(addresses.map((address) => [idOf(participants.find((candidate) => value(candidate) === address) ?? p('attendee', address), participants.findIndex((candidate) => value(candidate) === address)), true]));
    }
    return [idOf(property, i), entry];
  }));
  for (const [i, child] of subcomponents(comp, 'participant').entries()) {
    const current = record(out.participants) ? out.participants : {};
    const address = textValue(child, 'calendar-address');
    const match = Object.entries(current).find(([, v]) => record(v) && v.calendarAddress === address);
    const id = match?.[0] ?? componentId(child, i);
    const entry: Record<string, unknown> = record(current[id]) ? current[id] : {};
    for (const [js, name] of [['calendarAddress', 'calendar-address'], ['name', 'summary'], ['description', 'description']] as const) { const v = textValue(child, name); if (v !== null) entry[js] = v; }
    const childLinks = readLinks(child); if (Object.keys(childLinks).length) entry.links = childLinks;
    current[id] = entry; out.participants = current;
  }
  const related = getProps(comp, 'related-to');
  if (related.length) {
    const relations: Record<string, { relation: Record<string, boolean> }> = {};
    for (const property of related) {
      const key = String(value(property)); const relation = relations[key] ?? { relation: {} };
      const type = propParam(property, 'reltype'); if (type) relation.relation[type.toLowerCase()] = true;
      relations[key] = relation;
    }
    out.relatedTo = relations;
  }
  const alarms = subcomponents(comp, 'valarm');
  if (alarms.length) out.alerts = Object.fromEntries(alarms.map((alarm, i) => {
    const entry: Record<string, unknown> = {};
    const action = textValue(alarm, 'action')?.toLowerCase();
    if (action === 'display' || action === 'email') entry.action = action;
    const trigger = getProp(alarm, 'trigger');
    if (trigger) entry.trigger = propType(trigger) === 'date-time' ? { '@type': 'AbsoluteTrigger', when: value(trigger) }
      : { '@type': 'OffsetTrigger', offset: value(trigger), ...(propParam(trigger, 'related') === 'END' && { relativeTo: 'end' }) };
    const ack = textValue(alarm, 'acknowledged'); if (ack) entry.acknowledged = ack;
    const related: Record<string, { relation: Record<string, boolean> }> = {};
    for (const property of getProps(alarm, 'related-to')) {
      const target = subcomponents(comp, 'valarm').findIndex((candidate) => textValue(candidate, 'uid') === value(property));
      if (target < 0) continue;
      const key = componentId(subcomponents(comp, 'valarm')[target]!, target);
      const relation = related[key] ?? { relation: {} }; const type = propParam(property, 'reltype');
      if (type) relation.relation[type.toLowerCase()] = true; related[key] = relation;
    }
    if (Object.keys(related).length) entry.relatedTo = related;
    return [componentId(alarm, i), entry];
  }));
  applyJSProps(out, comp);
  // Source data is intentionally not revalidated: imported iCalendar can have values unknown to us.
  return out as JSEvent;
}
const valueOrUndefined = (comp: JCalComponent, name: string) => { const prop = getProp(comp, name); return prop && value(prop); };

/** JSPROP only adds missing fields; it cannot overwrite mapped data (mapping-29 §4.1.2). */
function applyJSProps(out: Record<string, unknown>, comp: JCalComponent): void {
  for (const property of getProps(comp, 'jsprop')) {
    const pointer = propParam(property, 'jsptr'), raw = value(property);
    if (!pointer || typeof raw !== 'string') continue;
    try {
      const tokens = pointerTokens(pointer);
      let target = out;
      for (const token of tokens.slice(0, -1)) {
        const next = Object.hasOwn(target, token) ? target[token] : undefined;
        if (!record(next)) throw new Error('Invalid JSPTR parent');
        target = next;
      }
      const key = tokens.at(-1)!;
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && !Object.hasOwn(target, key)) Object.defineProperty(target, key, { value: parsed, enumerable: true, configurable: true, writable: true });
    } catch { /* Preserve malformed source JSPROPs in the underlying jCal, without overriding valid fields. */ }
  }
}

export function toJSCalendar(resource: EventResource): JSEvent | JSGroup {
  if (!resource.master) {
    const entries = resource.overrides.map((c) => readComponent(c, resource));
    if (entries.length === 1) return entries[0]!;
    return { '@type': 'Group', version: '2.0', uid: resource.uid, entries };
  }
  const event = readComponent(resource.master, resource);
  const overrides: Record<string, PatchObject> = {};
  for (const name of ['rdate', 'exdate']) for (const property of getProps(resource.master, name)) for (const date of propValues(property)) {
    const [start, end] = Array.isArray(date) ? date : typeof date === 'string' ? date.split('/') : [];
    if (typeof start !== 'string') continue;
    const key = wallIn(start!, event.timeZone, propParam(property, 'tzid'));
    let duration: string | undefined;
    if (typeof end === 'string') {
      if (end.startsWith('P')) duration = end;
      else duration = readComponent(['vevent', [p('dtstart', start, 'date-time', propParams(property)), p('dtend', end, 'date-time', propParams(property))], []], resource).duration;
    }
    overrides[key] = name === 'exdate' ? { excluded: true } : duration ? { duration } : {};
  }
  for (const comp of resource.overrides) {
    const rid = recurrenceId(comp); if (!rid) continue;
    const key = wallIn(rid, event.timeZone, propParam(getProp(comp, 'recurrence-id')!, 'tzid'));
    const actual = readComponent(comp, resource);
    const base: Record<string, unknown> = { ...event, start: key };
    for (const forbidden of forbiddenOverride) { delete base[forbidden]; delete actual[forbidden]; }
    overrides[key] = Object.fromEntries(Object.entries(diffObjects(base, actual)).filter(([pointer]) => !invalidOverridePointer(pointer)));
  }
  if (Object.keys(overrides).length) event.recurrenceOverrides = overrides;
  return event;
}

function writeRule(event: JSEvent): JCalProperty[] {
  if (!event.recurrenceRule) return [];
  const out: Record<string, JCalValue> = {};
  for (const [js, name] of Object.entries(ruleKeys)) {
    let v = event.recurrenceRule[js];
    if (v === undefined) continue;
    if (js === 'byDay' && Array.isArray(v)) v = v.map((d: unknown) => record(d) ? `${d.nthOfPeriod ?? ''}${String(d.day).toUpperCase()}` : String(d));
    else if (js === 'until' && typeof v === 'string') v = event.timeZone ? Temporal.PlainDateTime.from(v).toZonedDateTime(event.timeZone).toInstant().toString({ smallestUnit: 'second' }) : allDay(event) ? v.slice(0, 10) : v;
    else if (js === 'byMonth' && Array.isArray(v)) v = v.map((n: unknown) => /L$/.test(String(n)) ? String(n) : Number(n));
    else if (typeof v === 'string') v = v.toUpperCase();
    out[name] = v as JCalValue;
  }
  return [p('rrule', out, 'recur')];
}

// DATE is permitted only when every temporal value has a zero time component.
function allDay(event: JSEvent): boolean {
  return event.showWithoutTime === true && !event.timeZone && !event.endTimeZone &&
    [event.start, event.recurrenceId, event.recurrenceRule?.until, ...Object.keys(event.recurrenceOverrides ?? {})].every((v) => !v || /T00:00:00(?:\.0+)?$/.test(v)) &&
    (!event.duration || [Temporal.Duration.from(event.duration).hours, Temporal.Duration.from(event.duration).minutes, Temporal.Duration.from(event.duration).seconds].every((v) => v === 0));
}
function dateProp(name: string, date: string, event: JSEvent, zone = event.timeZone): JCalProperty {
  return p(name, allDay(event) ? date.slice(0, 10) : date, allDay(event) ? 'date' : 'date-time', zone ? { tzid: zone } : {});
}

function buildComponent(event: JSEvent): JCalComponent {
  const props: JCalProperty[] = [];
  const children: JCalComponent[] = [];
  for (const [js, name] of Object.entries(scalar)) {
    const v = event[js];
    if (typeof v === 'string' || typeof v === 'number') props.push(p(name, v, ['priority', 'sequence'].includes(js) ? 'integer' : ['created', 'updated'].includes(js) ? 'date-time' : js === 'organizerCalendarAddress' ? 'cal-address' : 'text', js === 'title' && event.locale ? { language: event.locale } : {}));
  }
  if (event.updated) props.push(p('dtstamp', event.updated, 'date-time'));
  props.push(dateProp('dtstart', event.start, event));
  if (event.recurrenceId) props.push(dateProp('recurrence-id', event.recurrenceId, event, event.recurrenceIdTimeZone));
  if (event.endTimeZone) {
    const end = Temporal.PlainDateTime.from(event.start).toZonedDateTime(event.timeZone ?? 'UTC').add(Temporal.Duration.from(event.duration ?? 'PT0S')).withTimeZone(event.endTimeZone).toPlainDateTime();
    props.push(dateProp('dtend', fmt(end), event, event.endTimeZone));
  } else if (event.duration || allDay(event)) props.push(p('duration', event.duration ?? 'PT0S', 'duration'));
  if (event.showWithoutTime && !allDay(event)) props.push(p('show-without-time', true, 'boolean'));
  if (event.status && ['confirmed', 'tentative', 'cancelled'].includes(event.status)) props.push(p('status', event.status.toUpperCase()));
  if (event.freeBusyStatus && ['free', 'busy'].includes(event.freeBusyStatus)) props.push(p('transp', event.freeBusyStatus === 'free' ? 'TRANSPARENT' : 'OPAQUE'));
  if (event.privacy && ['public', 'private', 'secret'].includes(event.privacy)) props.push(p('class', event.privacy === 'secret' ? 'CONFIDENTIAL' : event.privacy.toUpperCase()));
  if (event.keywords && Object.keys(event.keywords).length) props.push(['categories', {}, 'text', ...Object.keys(event.keywords)]);
  props.push(...writeRule(event));
  const locationEntries = Object.entries(event.locations ?? {});
  const main = event.mainLocationId ?? (locationEntries.length === 1 ? locationEntries[0]![0] : undefined);
  for (const [id, location] of locationEntries) {
    const simple = locationEntries.length === 1 && Object.keys(location).every((k) => ['name', '@type'].includes(k));
    if (!simple) {
      const lp: JCalProperty[] = [p('jsid', id)];
      for (const [js, name] of [['name', 'name'], ['description', 'description'], ['coordinates', 'coordinates']] as const) if (location[js] !== undefined) lp.push(p(name, location[js]!, js === 'coordinates' ? 'uri' : 'text'));
      if (location.locationTypes) lp.push(['location-type', {}, 'text', ...Object.keys(location.locationTypes)]);
      children.push(['vlocation', lp, []]);
    }
    if (id === main && location.name !== undefined) props.push(p('location', location.name, 'text', { jsid: id, ...(!simple && { derived: 'TRUE' }) }));
  }
  for (const [id, location] of Object.entries(event.virtualLocations ?? {})) props.push(p('conference', location.uri, 'uri', { jsid: id, ...(location.name !== undefined && { label: location.name }), ...(location.features && record(location.features) && { feature: Object.keys(location.features).map((feature) => feature.toUpperCase()) }) }));
  props.push(...writeLinks(event.links));
  for (const [id, participant] of Object.entries(event.participants ?? {})) {
    if (!participant.calendarAddress || participant.description !== undefined || participant.links !== undefined) {
      const pp: JCalProperty[] = [p('jsid', id), p('uid', `${event.uid ?? ''}-${id}`)];
      if (participant.calendarAddress) pp.push(p('calendar-address', participant.calendarAddress, 'cal-address'));
      if (participant.name !== undefined) pp.push(p('summary', participant.name));
      if (typeof participant.description === 'string') pp.push(p('description', participant.description));
      const links = JSEvent.shape.links.safeParse(participant.links);
      if (links.success) pp.push(...writeLinks(links.data));
      children.push(['participant', pp, []]);
    }
    if (!participant.calendarAddress) continue;
    const params: JCalParams = { jsid: id };
    for (const [js, name] of Object.entries(participantParams)) {
      const v = participant[js]; if (v !== undefined) params[name] = ['kind', 'participationStatus', 'expectReply'].includes(js) ? String(v).toUpperCase() : String(v);
    }
    if (participant.kind === 'location') params.cutype = 'ROOM';
    if (participant.roles && Object.keys(participant.roles).length) params.role = Object.keys(participant.roles).map((role) => ({ chair: 'CHAIR', owner: 'OWNER', optional: 'OPT-PARTICIPANT', attendee: 'REQ-PARTICIPANT', informational: 'NON-PARTICIPANT' })[role] ?? role.toUpperCase());
    for (const [js, name] of [['delegatedTo', 'delegated-to'], ['delegatedFrom', 'delegated-from'], ['memberOf', 'member']] as const) {
      if (participant[js]) params[name] = Object.keys(participant[js]).flatMap((key) => event.participants?.[key]?.calendarAddress ?? []);
    }
    props.push(p('attendee', participant.calendarAddress, 'cal-address', params));
  }
  for (const [uid, related] of Object.entries(event.relatedTo ?? {})) {
    const relations = Object.keys(related.relation ?? {});
    if (!relations.length) props.push(p('related-to', uid));
    else for (const type of relations) props.push(p('related-to', uid, 'text', { reltype: type.toUpperCase() }));
  }
  for (const [id, alert] of Object.entries(event.alerts ?? {})) {
    const ap: JCalProperty[] = [p('jsid', id), p('uid', id)];
    ap.push(p('action', (alert.action ?? 'display').toUpperCase()), p('description', event.title ?? ''));
    if (alert.action === 'email') ap.push(p('summary', event.title ?? ''));
    if (alert.trigger?.['@type'] === 'AbsoluteTrigger' && alert.trigger.when) ap.push(p('trigger', alert.trigger.when, 'date-time'));
    else if (alert.trigger?.['@type'] === 'OffsetTrigger' && alert.trigger.offset) ap.push(p('trigger', alert.trigger.offset, 'duration', alert.trigger.relativeTo === 'end' ? { related: 'END' } : {}));
    for (const [relatedId, relation] of Object.entries(alert.relatedTo ?? {})) {
      const types = Object.keys(relation.relation ?? {});
      if (!types.length) ap.push(p('related-to', relatedId));
      else for (const type of types) ap.push(p('related-to', relatedId, 'text', { reltype: type.toUpperCase() }));
    }
    if (alert.acknowledged) ap.push(p('acknowledged', alert.acknowledged, 'date-time'));
    children.push(['valarm', ap, []]);
  }
  return ['vevent', props, children];
}

/** Store only fields absent from the standard mapping; a JSPROP never shadows mapped data. */
function extraProps(input: Record<string, unknown>, mapped: Record<string, unknown>, prefix = ''): JCalProperty[] {
  const out: JCalProperty[] = [];
  for (const [key, v] of Object.entries(input)) {
    if (v === undefined || v === null || (prefix === '' && (key === 'prodId' || (key === 'recurrenceOverrides' && record(v) && Object.keys(v).length > 0)))) continue;
    const pointer = prefix + escapePointer(key);
    if (!Object.hasOwn(mapped, key)) out.push(p('jsprop', JSON.stringify(v), 'text', { jsptr: pointer }));
    else if (record(v) && record(mapped[key])) out.push(...extraProps(v, mapped[key], `${pointer}/`));
  }
  return out;
}
const mappedParameters: Record<string, string[]> = {
  dtstart: ['tzid'], dtend: ['tzid'], 'recurrence-id': ['tzid'], rdate: ['tzid'], exdate: ['tzid'], summary: ['language'],
  attendee: ['cn', 'email', 'cutype', 'partstat', 'rsvp', 'role', 'delegated-to', 'delegated-from', 'member', 'sent-by'],
  organizer: ['cn', 'email', 'sent-by'], location: ['derived'], conference: ['label', 'feature'],
  attach: ['filename', 'fmttype', 'size'], image: ['filename', 'fmttype', 'size', 'display'], link: ['label', 'fmttype', 'size', 'linkrel'], url: ['label'], 'related-to': ['reltype'],
};
function mergePropertyParams(property: JCalProperty, old?: JCalProperty): JCalProperty {
  const name = propName(property);
  const params = old ? propParams(old) : {};
  for (const key of mappedParameters[name] ?? []) delete params[key];
  return [name, { ...params, ...propParams(property) }, propType(property), ...propValues(property)];
}
function mergeChild(child: JCalComponent, old: JCalComponent | undefined, kind: string): JCalComponent {
  if (!old) return child;
  let result = old;
  const mapped = kind === 'valarm' ? ['jsid', 'action', 'trigger', 'acknowledged', 'related-to'] : kind === 'participant' ? ['jsid', 'uid', 'calendar-address', 'summary', 'description', 'attach', 'link', 'url', 'image'] : ['jsid', 'name', 'description', 'coordinates', 'location-type'];
  for (const name of mapped) result = replaceProperties(result, name, getProps(child, name).map((property, i) => mergePropertyParams(property, getProps(old, name)[i])));
  return result;
}
const groups: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(scalar).map(([js, name]) => [name, [js]])), dtstamp: ['updated'], dtstart: ['start', 'timeZone', 'showWithoutTime'],
  dtend: ['start', 'duration', 'timeZone', 'endTimeZone'], duration: ['duration', 'endTimeZone'], status: ['status'], transp: ['freeBusyStatus'], class: ['privacy'], categories: ['keywords'],
  rrule: ['recurrenceRule', 'timeZone', 'showWithoutTime'], location: ['locations', 'mainLocationId'], conference: ['virtualLocations'], attach: ['links'], image: ['links'], link: ['links'], url: ['links'], attendee: ['participants'], 'related-to': ['relatedTo'],
  'recurrence-id': ['recurrenceId', 'recurrenceIdTimeZone'], 'show-without-time': ['showWithoutTime', 'timeZone'], summary: ['title', 'locale'],
};

function convertComponent(event: JSEvent, previous: JCalComponent | null, resource: EventResource): JCalComponent {
  const fresh = buildComponent(event);
  const mapped = readComponent(fresh, resource);
  const jsprops = extraProps(event, mapped);
  let result = previous ?? fresh;
  const before = previous && readComponent(previous, resource);
  for (const name of Object.keys(groups)) {
    if (before && groups[name]!.every((field) => isDeepStrictEqual(before[field], event[field]))) continue;
    const olds = previous ? getProps(previous, name) : [];
    const next = getProps(fresh, name).map((property, i) => {
      const old = olds.find((candidate) => propParam(candidate, 'jsid') === propParam(property, 'jsid')) ?? olds[i];
      return mergePropertyParams(property, old);
    });
    result = next.length === 1 ? setProp(result, next[0]!) : replaceProperties(result, name, next);
  }
  for (const [name, field] of [['valarm', 'alerts'], ['vlocation', 'locations'], ['participant', 'participants']] as const) {
    if (!before || !isDeepStrictEqual(before[field], event[field])) {
      const olds = previous ? subcomponents(previous, name) : [];
      const next = subcomponents(fresh, name).map((child, i) => mergeChild(child, olds.find((candidate, j) => componentId(candidate, j) === componentId(child, i)) ?? olds[i], name));
      result = replaceSubcomponents(result, name, next);
    }
  }
  // Rewrite represented JS fields; retain malformed or shadowed source JSPROPs verbatim.
  const retained = previous ? getProps(previous, 'jsprop').filter((property) => {
    const pointer = propParam(property, 'jsptr');
    if (!pointer) return true;
    try {
      const field = pointerTokens(pointer)[0]!;
      return !Object.hasOwn(event, field) && !Object.hasOwn(before ?? {}, field);
    } catch { return true; }
  }) : [];
  result = replaceProperties(result, 'jsprop', [...retained, ...jsprops.map((property) => {
    const old = previous && getProps(previous, 'jsprop').find((candidate) => propParam(candidate, 'jsptr') === propParam(property, 'jsptr'));
    return ['jsprop', { ...(old ? propParams(old) : {}), ...propParams(property) }, 'text', ...propValues(property)] satisfies JCalProperty;
  })]);
  return result;
}

function recurrenceProperty(name: string, key: string, event: JSEvent, previous: EventResource | null): JCalProperty {
  const old = previous?.master && getProps(previous.master, name).find((property) => propValues(property).some((v) => typeof v === 'string' && wallIn(v.split('/')[0]!, event.timeZone, propParam(property, 'tzid')) === key));
  return mergePropertyParams(dateProp(name, key, event), old || undefined);
}

/** Convert against a copy of previous, changing mapped property groups while retaining source extensions. */
export function fromJSCalendar(input: JSEvent, previous: EventResource | null, now: Temporal.Instant): EventResource {
  const event = JSEvent.parse(input);
  const uid = event.uid ?? previous?.uid ?? crypto.randomUUID();
  event.uid = uid;
  const resource: EventResource = { uid, master: null, overrides: [], timezones: { ...previous?.timezones } };
  resource.master = convertComponent(event, previous?.master ?? null, resource);
  resource.master = removeProps(resource.master, ['rdate', 'exdate']);
  for (const [date, patch] of Object.entries(event.recurrenceOverrides ?? {})) {
    const parsedDate = Temporal.PlainDateTime.from(date); // Validate override keys even for exclusions.
    const key = fmt(parsedDate);
    for (const pointer of Object.keys(patch)) {
      if (invalidOverridePointer(pointer)) throw new InvalidPatchError(`recurrenceOverrides/${escapePointer(date)}/${pointer}`, 'Property is forbidden in a recurrence override');
    }
    if (patch.excluded === true) {
      if (Object.keys(patch).length !== 1) throw new InvalidPatchError(`recurrenceOverrides/${escapePointer(date)}`, 'An excluded override must only contain excluded:true');
      resource.master = replaceProperties(resource.master, 'exdate', [...getProps(resource.master, 'exdate'), recurrenceProperty('exdate', key, event, previous)]);
    } else if (Object.keys(patch).length === 0) {
      resource.master = replaceProperties(resource.master, 'rdate', [...getProps(resource.master, 'rdate'), recurrenceProperty('rdate', key, event, previous)]);
    } else {
      if (Object.hasOwn(patch, 'excluded')) throw new InvalidPatchError(`recurrenceOverrides/${escapePointer(date)}/excluded`, 'excluded must be true');
      const base = { ...event, start: key }; delete base.recurrenceOverrides; delete base.recurrenceRule;
      const actual = applyPatch(base, patch);
      const prior = previous?.overrides.find((comp) => wallIn(recurrenceId(comp) ?? '', event.timeZone, propParam(getProp(comp, 'recurrence-id')!, 'tzid')) === key) ?? null;
      const comp = convertComponent(actual, prior, resource);
      resource.overrides.push(setProp(removeProps(comp, ['rrule', 'rdate', 'exdate']), mergePropertyParams(dateProp('recurrence-id', key, event), prior ? getProp(prior, 'recurrence-id') : undefined)));
    }
  }
  return addMissingTimezones(resource, now);
}

export const objectNameFor = async (uid: string): Promise<string> => `${createHash('sha256').update(uid).digest('base64url').slice(0, 22)}.ics`;
