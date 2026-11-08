import { describe, expect, test } from 'bun:test';
import { Temporal } from '@js-temporal/polyfill';
import { readFileSync } from 'node:fs';
import { applyPatch, expandOccurrences, fromJSCalendar, getProps, InvalidPatchError, InvalidSplitError, JSEvent, objectNameFor, parseCalendar, properties, propName, recurrenceId, serializeCalendar, splitEvent, textValue, propParam, getProp, subcomponents, toJSCalendar, type EventResource, type PatchObject } from '../src/index.ts';
import examples from './fixtures/jscalendar-2.0-examples.json';

const now = Temporal.Instant.from('2026-11-08T12:00:00Z');
const base = JSEvent.parse({ '@type': 'Event', uid: 'test', start: '2026-11-12T09:00:00', timeZone: 'Europe/Madrid', duration: 'PT1H', title: 'Team sync' });
const convert = (input: unknown) => fromJSCalendar(JSEvent.parse(input), null, now);
function eventOf(resource: EventResource) { const result = toJSCalendar(resource); if (result['@type'] !== 'Event') throw new Error('Expected Event'); return result; }

describe('JSCalendar 2.0', () => {
  test('draft bis-22 §5.1, 5.4 and 5.6–5.11 examples round-trip through iCalendar', () => {
    expect(examples).toHaveLength(9);
    for (const [i, example] of examples.entries()) {
      const event = JSEvent.parse({ '@type': 'Event', uid: `example-${i}`, ...example });
      const resource = fromJSCalendar(event, null, now);
      const parsed = parseCalendar(serializeCalendar({ props: [], resources: [resource] }));
      expect(parsed.errors).toEqual([]);
      expect(eventOf(parsed.resources[0]!)).toEqual(event);
    }
  });
  test('the tricky corpus reads and a REST edit retains every unmapped property and unknown parameter', () => {
    const corpus = parseCalendar(readFileSync(new URL('./fixtures/tricky.ics', import.meta.url), 'utf8'));
    const mapped = new Set(['uid','summary','description','dtstart','duration','dtend','status','transp','class','color','categories','priority','sequence','created','last-modified','dtstamp','location','conference','attach','attendee','organizer','rrule','exdate','rdate','recurrence-id','related-to','jsprop','show-without-time']);
    for (const resource of corpus.resources) {
      const event = toJSCalendar(resource);
      if (event['@type'] !== 'Event' || !resource.master) continue;
      const next = fromJSCalendar(event, resource, now);
      expect(properties(next.master!).filter((p) => !mapped.has(propName(p)))).toEqual(properties(resource.master).filter((p) => !mapped.has(propName(p))));
      for (const old of properties(resource.master)) {
        if (['exdate','rdate','jsprop'].includes(propName(old))) continue;
        expect(getProps(next.master!, propName(old))).toContainEqual(old);
      }
    }
  });
  test('edits preserve unknown parameters on the master, exclusions, overrides and alarms', () => {
    const raw = ['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:extensions','DTSTART:20261112T090000Z','DURATION:PT1H','RRULE:FREQ=WEEKLY;COUNT=4','SUMMARY;X-UNMAPPED=master:Before','EXDATE;X-UNMAPPED=exclude:20261119T090000Z','X-MASTER;X-PARAM=opaque:keep','BEGIN:VALARM','ACTION:DISPLAY','TRIGGER;X-UNMAPPED=alarm:-PT10M','X-ALARM:keep','END:VALARM','END:VEVENT','BEGIN:VEVENT','UID:extensions','RECURRENCE-ID;X-UNMAPPED=override:20261126T090000Z','DTSTART:20261126T100000Z','DURATION:PT1H','X-OVERRIDE;X-PARAM=opaque:keep','END:VEVENT','END:VCALENDAR',''].join('\r\n');
    const resource = parseCalendar(raw).resources[0]!;
    const event = applyPatch(eventOf(resource), { title: 'After', 'alerts/1/trigger/offset': '-PT15M' });
    const edited = fromJSCalendar(event, resource, now);
    expect(propParam(getProp(edited.master!, 'summary')!, 'x-unmapped')).toBe('master');
    expect(propParam(getProp(edited.master!, 'exdate')!, 'x-unmapped')).toBe('exclude');
    expect(propParam(getProp(edited.overrides[0]!, 'recurrence-id')!, 'x-unmapped')).toBe('override');
    expect(textValue(edited.overrides[0]!, 'x-override')).toBe('keep');
    const alarm = subcomponents(edited.master!, 'valarm')[0]!;
    expect(textValue(alarm, 'x-alarm')).toBe('keep'); expect(propParam(getProp(alarm, 'trigger')!, 'x-unmapped')).toBe('alarm');
  });
  test('mapped fields retain standard meanings, including link relations, multi-role participants and alarms', () => {
    const event = JSEvent.parse({ ...base, description: 'Details', status: 'tentative', freeBusyStatus: 'free', privacy: 'secret', color: 'teal', priority: 2, sequence: 3, keywords: { work: true },
      links: { attachment: { href: 'https://example.test/file', rel: 'enclosure' }, image: { href: 'https://example.test/icon', rel: 'icon' }, page: { href: 'https://example.test/page', rel: 'describedby' }, other: { href: 'https://example.test/related', rel: 'related' } },
      participants: { alice: { calendarAddress: 'mailto:alice@example.test', name: 'Alice', roles: { owner: true, chair: true }, participationStatus: 'accepted' }, room: { name: 'Room', description: 'Upstairs' } },
      virtualLocations: { meet: { uri: 'https://meet.example.test', features: { audio: true, video: true } } },
      alerts: { alarm: { trigger: { offset: '-PT10M' } } },
    });
    const resource = convert(event), ics = serializeCalendar({ props: [], resources: [resource] });
    expect(ics).toContain('CLASS:CONFIDENTIAL'); expect(ics).toContain('ROLE=OWNER,CHAIR'); expect(ics).toContain('BEGIN:PARTICIPANT');
    expect(ics).toContain('LINK;'); expect(ics).toContain('IMAGE;'); expect(ics).toContain('ATTACH;'); expect(ics).toContain('URL;');
    expect(eventOf(parseCalendar(ics).resources[0]!)).toEqual(event);
  });
  test('unknown fields use JSPROP, with escaped pointers, and never shadow mapped fields', () => {
    const event = JSEvent.parse({ ...base, 'example.com:tag': { value: [1, true, 'x'] }, 'example.com:payload': { 'a/b~c': 'escaped' }, futureThing: 3 });
    const resource = convert(event);
    expect(serializeCalendar({ props: [], resources: [resource] })).toContain('JSPROP;JSPTR="example.com:tag"');
    expect(eventOf(parseCalendar(serializeCalendar({ props: [], resources: [resource] })).resources[0]!)).toEqual(event);
  });
  test('a top-level null vendor value is absent because JSPROP cannot store JSON null', () => {
    const event = JSEvent.parse({ ...base, 'example.com:nullable': null });
    expect(eventOf(convert(event))['example.com:nullable']).toBeUndefined();
    expect(serializeCalendar({ props: [], resources: [convert(event)] })).not.toContain('JSPROP');
  });
  test('rejects 1.0 fields, unsupported versions, case errors, scheduling and non-IANA zones', () => {
    for (const bad of [{ recurrenceRules: [] }, { excludedRecurrenceRules: [] }, { timeZones: {} }, { method: 'request' }, { version: '1.0' }, { timeZone: 'Mars/Olympus' }, { Title: 'bad case' }, { locations: { one: { Name: 'bad case' } } }]) expect(() => JSEvent.parse({ ...base, ...bad })).toThrow();
    const result = JSEvent.safeParse({ ...base, recurrenceRules: [] });
    expect(!result.success && result.error.issues[0]).toMatchObject({ path: ['recurrenceRules'], message: expect.stringContaining('recurrenceRule') });
  });
  test('PatchObject rule 1: replace existing array members, including a nested field; never insert/delete', () => {
    const event = JSEvent.parse({ ...base, 'example.com:array': [{ label: 'before' }, 2] });
    expect(applyPatch(event, { 'example.com:array/0/label': 'after' })['example.com:array']).toEqual([{ label: 'after' }, 2]);
    for (const patch of [{ 'example.com:array/0': null }, { 'example.com:array/-': 3 }, { 'example.com:array/2': 3 }, { 'example.com:array/01': 3 }]) expect(() => applyPatch(event, patch)).toThrow(InvalidPatchError);
  });
  test('PatchObject rule 2: every intermediate token must exist; missing final object keys are permitted', () => {
    expect(() => applyPatch(base, { 'recurrenceOverrides/2026-11-19T09:00:00': {} })).toThrow(InvalidPatchError);
    expect(applyPatch(base, { 'recurrenceOverrides': { '2026-11-19T09:00:00': {} } }).recurrenceOverrides).toBeDefined();
    expect(applyPatch(base, { description: null })).toEqual(base);
  });
  test('PatchObject rule 3: rejects ancestor pointers in either order; token prefixes are compared after unescaping', () => {
    for (const patch of [{ title: 'x', 'title/a': 3 }, { 'title/a': 3, title: 'x' }, { 'example.com:a~1b/x': 2, 'example.com:a~1b': {} }]) expect(() => applyPatch(base, patch)).toThrow(InvalidPatchError);
    expect(applyPatch(base, { title: 'x', titleExtra: 'y' }).title).toBe('x');
  });
  test('PatchObject rule 4: validates values, required fields and atomic failure; supports escaped property names', () => {
    for (const patch of [{ start: null }, { '@type': null }, { version: null }, { uid: null }, { title: 4 }, { duration: 'garbage' }, { 'bad~2escape': 3 }]) expect(() => applyPatch(base, patch)).toThrow(InvalidPatchError);
    const patch: PatchObject = { title: 'mutated', duration: 5 };
    expect(() => applyPatch(base, patch)).toThrow(); expect(base.title).toBe('Team sync');
    expect(applyPatch(JSEvent.parse({ ...base, 'example.com:payload': {} }), { 'example.com:payload/a~1b~0c': 'yes' })['example.com:payload']).toEqual({ 'a/b~c': 'yes' });
    expect(() => applyPatch(base, JSON.parse('{"__proto__/polluted":true}'))).toThrow(InvalidPatchError);
  });
  test('overrides are complete VEVENTs, their patches inherit fields, and cancellations are EXDATEs', () => {
    const resource = convert({ ...base, recurrenceRule: { frequency: 'weekly', count: 3 }, recurrenceOverrides: { '2026-11-19T09:00:00': { start: '2026-11-19T10:00:00' }, '2026-11-26T09:00:00': { excluded: true } } });
    expect(resource.overrides).toHaveLength(1); expect(recurrenceId(resource.overrides[0]!)).toBe('2026-11-19T09:00:00');
    expect(textValue(resource.overrides[0]!, 'summary')).toBe('Team sync'); expect(getProps(resource.master!, 'exdate')).toHaveLength(1);
    expect(eventOf(resource).recurrenceOverrides).toEqual({ '2026-11-19T09:00:00': { start: '2026-11-19T10:00:00' }, '2026-11-26T09:00:00': { excluded: true } });
  });
  test('RDATE PERIOD maps its length and converts UTC recurrence identities into the event zone', () => {
    const raw = ['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:period','DTSTART;TZID=Europe/Madrid:20261112T090000','DURATION:PT1H','RRULE:FREQ=WEEKLY;COUNT=2','RDATE;VALUE=PERIOD:20261119T080000Z/PT2H','END:VEVENT','END:VCALENDAR',''].join('\r\n');
    const resource = parseCalendar(raw).resources[0]!;
    expect(eventOf(resource).recurrenceOverrides).toEqual({ '2026-11-19T09:00:00': { duration: 'PT2H' } });
    const expansion = expandOccurrences(resource, { from: Temporal.Instant.from('2026-11-19T00:00:00Z'), to: Temporal.Instant.from('2026-11-20T00:00:00Z') });
    expect(expansion.occurrences[0]?.end.toString()).toBe('2026-11-19T10:00:00Z');
  });
  test('split rejects first occurrence, non-occurrences and non-recurring events', () => {
    const resource = convert({ ...base, recurrenceRule: { frequency: 'weekly', count: 5 } });
    for (const at of [base.start, '2026-11-13T09:00:00']) expect(() => splitEvent(resource, at, 'next', now)).toThrow(InvalidSplitError);
    expect(() => splitEvent(convert(base), '2026-11-19T09:00:00', 'next', now)).toThrow(InvalidSplitError);
  });
  test('split COUNT includes excluded rule instances, moves later overrides, and sets reciprocal relations', () => {
    const resource = convert({ ...base, recurrenceRule: { frequency: 'weekly', count: 5 }, recurrenceOverrides: { '2026-11-19T09:00:00': { excluded: true }, '2026-12-10T09:00:00': { title: 'Last' } } });
    const parts = splitEvent(resource, '2026-12-03T09:00:00', 'next', now);
    const a = eventOf(parts.original), b = eventOf(parts.next);
    expect(a.recurrenceRule?.count).toBe(3); expect(b.recurrenceRule?.count).toBe(2);
    expect(a.recurrenceOverrides).toEqual({ '2026-11-19T09:00:00': { excluded: true } });
    expect(b.recurrenceOverrides).toEqual({ '2026-12-10T09:00:00': { title: 'Last' } });
    expect(a.relatedTo?.next?.relation).toEqual({ next: true }); expect(b.relatedTo?.test?.relation).toEqual({ first: true });
  });
  test('split UNTIL preserves the bound and wall time across DST', () => {
    const resource = convert({ ...base, start: '2026-10-15T09:00:00', recurrenceRule: { frequency: 'weekly', until: '2026-11-12T09:00:00' } });
    const parts = splitEvent(resource, '2026-10-29T09:00:00', 'next', now);
    expect(eventOf(parts.original).recurrenceRule?.until).toBe('2026-10-22T09:00:00'); expect(eventOf(parts.next).recurrenceRule?.until).toBe('2026-11-12T09:00:00');
    const window = { from: Temporal.Instant.from('2026-10-01T00:00:00Z'), to: Temporal.Instant.from('2026-12-01T00:00:00Z') };
    const times = [parts.original, parts.next].flatMap((r) => expandOccurrences(r, window).occurrences.map((o) => o.start.toString()));
    expect(times).toEqual(['2026-10-15T07:00:00Z','2026-10-22T07:00:00Z','2026-10-29T08:00:00Z','2026-11-05T08:00:00Z','2026-11-12T08:00:00Z']);
  });
  test('object names hash the UID, never embed path characters', async () => { expect(await objectNameFor('a/b@c')).toMatch(/^[A-Za-z0-9_-]{22}\.ics$/); });
});
