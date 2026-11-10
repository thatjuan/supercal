/** Pure field mapping, notification policy and recurrence replacement cases. */
import { getProp, googleEndTime, googleTime, normalizeGoogle, parseCalendar, type EventResource } from '@supercal/core';
import { describe, expect, test } from 'bun:test';
import { googleEventBody, googlePatch, googleSendUpdates, googleWriteOps, StoredGoogleEvent, ProviderWriteRejectedError, type StoredObject } from '../src/index.ts';

/** Parse a single UID group's components for converter tests. */
function resource(lines: string[], overrides: string[][] = []): EventResource {
  const vevent = (props: string[]) => ['BEGIN:VEVENT', 'UID:test@example.test', 'DTSTAMP:20261101T000000Z', ...props, 'END:VEVENT'];
  const parsed = parseCalendar(['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevent(lines), ...overrides.flatMap(vevent), 'END:VCALENDAR', ''].join('\r\n'));
  if (!parsed.resources[0] || parsed.errors.length) throw new Error(JSON.stringify(parsed.errors));
  return parsed.resources[0];
}
const dates = ['DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261102'];
const base = [...dates, 'SUMMARY:Master', 'RRULE:FREQ=DAILY;COUNT=10'];
const master = { id: 'master', etag: '"master"', iCalUID: 'test@example.test', summary: 'Master', start: { date: '2026-11-01' }, end: { date: '2026-11-02' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=10'] };
const override = { ...master, id: 'exception', etag: '"exception"', recurringEventId: 'master', originalStartTime: { date: '2026-11-03' }, start: { date: '2026-11-04' }, end: { date: '2026-11-05' }, recurrence: undefined, summary: 'Moved' };
/** Convert a Google fixture to the adapter's stored-object contract. */
const stored = (event: typeof master | typeof override): StoredObject => ({ id: event.id, etag: event.etag, payload: JSON.parse(JSON.stringify(event)) });
/** Body for the parsed master. */
function bodyOf(input: EventResource, event?: StoredGoogleEvent) {
  if (!input.master) throw new Error('missing master');
  return googleEventBody(input.master, input, 'America/Vancouver', event);
}

describe('Google write mapping', () => {
  test('every mapped field survives conversion through normalizeGoogle', () => {
    const input = resource(['DTSTART;TZID=Europe/Paris:20261109T090000', 'DURATION:PT1H', 'SUMMARY:Planning', 'DESCRIPTION:Notes\\nSecond line', 'LOCATION:Office', 'STATUS:TENTATIVE', 'TRANSP:TRANSPARENT', 'CLASS:CONFIDENTIAL', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=Europe/Paris:20261116T090000', 'RDATE;TZID=Europe/Paris:20261118T090000', 'ATTENDEE;CN=Grace;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:grace@example.test', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-PT1H', 'END:VALARM']);
    const op = googleWriteOps(input, [], 'UTC')[0];
    if (op?.op !== 'import') throw new Error('expected import');
    expect(op.body).toMatchObject({ iCalUID: input.uid, summary: 'Planning', description: 'Notes\nSecond line', location: 'Office', visibility: 'confidential', transparency: 'transparent', status: 'tentative', attendees: [{ email: 'grace@example.test', displayName: 'Grace', optional: true, responseStatus: 'accepted' }], reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }, { method: 'email', minutes: 60 }] } });
    expect(op.body.recurrence).toContain('EXDATE;TZID=Europe/Paris:20261116T090000');
    expect(op.body.recurrence).toContain('RDATE;TZID=Europe/Paris:20261118T090000');
    const result = normalizeGoogle([{ id: 'one', etag: '1', groupUid: input.uid, payload: JSON.stringify({ ...op.body, id: 'one', start: { dateTime: '2026-11-09T09:00:00+01:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-11-09T10:00:00+01:00', timeZone: 'Europe/Paris' } }) }]);
    expect(result).not.toBeNull();
    const next = result && googleWriteOps(result.resource, [], 'UTC')[0];
    expect(next).toEqual(op);
  });

  test.each([['', 'default'], ['CLASS:PRIVATE', 'private'], ['CLASS:PUBLIC', 'public'], ['CLASS:CONFIDENTIAL', 'confidential']] as const)('maps visibility %s', (line, visibility) => {
    expect(bodyOf(resource([...dates, ...(line ? [line] : [])])).visibility).toBe(visibility);
  });
  test.each([['STATUS:CANCELLED', 'cancelled'], ['STATUS:TENTATIVE', 'tentative'], ['', 'confirmed']] as const)('maps status %s', (line, mapped) => {
    expect(bodyOf(resource([...dates, ...(line ? [line] : [])])).status).toBe(mapped);
  });
  test('all-day defaults to one day, floating uses calendar zone, UTC stays an instant, and duration sets end', () => {
    expect(bodyOf(resource(['DTSTART;VALUE=DATE:20261101']))).toMatchObject({ start: { date: '2026-11-01' }, end: { date: '2026-11-02' } });
    expect(bodyOf(resource(['DTSTART:20261101T090000', 'DURATION:PT90M']))).toMatchObject({ start: { dateTime: '2026-11-01T09:00:00', timeZone: 'America/Vancouver' }, end: { dateTime: '2026-11-01T10:30:00', timeZone: 'America/Vancouver' } });
    expect(bodyOf(resource(['DTSTART:20261101T090000Z', 'DURATION:PT1H']))).toMatchObject({ start: { dateTime: '2026-11-01T09:00:00Z' }, end: { dateTime: '2026-11-01T10:00:00Z' } });
    expect(bodyOf(resource(['DTSTART:20261101T090000Z', 'DURATION:P1D'])).end).toEqual({ dateTime: '2026-11-02T09:00:00Z' });
    const input = resource(['DTSTART;TZID=Europe/Paris:20261101T090000', 'DTEND;TZID=Europe/Paris:20261101T103000']);
    if (!input.master) throw new Error('master');
    expect(googleEndTime(input.master, googleTime(getProp(input.master, 'dtstart')!, input, 'UTC'), input, 'UTC')).toEqual({ dateTime: '2026-11-01T10:30:00', timeZone: 'Europe/Paris' });
  });
  test('default alarms stay untouched, explicit alarms can clear, unsupported triggers are ignored, and six are refused', () => {
    const previous = StoredGoogleEvent.parse({ ...master, reminders: { useDefault: true } });
    expect(bodyOf(resource(dates), previous).reminders).toBeUndefined();
    expect(bodyOf(resource(dates)).reminders).toEqual({ useDefault: false, overrides: [] });
    const alarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM'];
    expect(bodyOf(resource([...dates, ...Array.from({ length: 5 }, () => alarm).flat()])).reminders?.overrides).toHaveLength(5);
    expect(() => bodyOf(resource([...dates, ...Array.from({ length: 6 }, () => alarm).flat()]))).toThrow(ProviderWriteRejectedError);
    expect(bodyOf(resource([...dates, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT10M', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT5M', 'END:VALARM'])).reminders).toEqual({ useDefault: false, overrides: [] });
  });
  test('PATCH clears removed mapped fields and leaves Google-only fields alone', () => {
    const previous = StoredGoogleEvent.parse({ ...master, description: 'old', location: 'old', colorId: '7', attachments: [{ fileId: 'file' }], conferenceData: { entryPoints: [{ uri: 'https://meet.test' }] }, extendedProperties: { private: { key: 'value' } } });
    expect(googlePatch(bodyOf(resource([...dates, 'SUMMARY:Master']), previous), previous)).toEqual({ description: '', location: '' });
    const defaults = StoredGoogleEvent.parse({ ...master, reminders: { useDefault: true } });
    expect(googlePatch(bodyOf(resource([...dates, 'SUMMARY:Master']), defaults), defaults)).toEqual({});
  });
  test('attendees retain Google metadata but remove a deleted CN; RSVP changes notify only the organizer', () => {
    const previous = StoredGoogleEvent.parse({ ...master, attendees: [{ email: 'me@example.test', self: true, responseStatus: 'needsAction' }, { email: 'other@example.test', displayName: 'Other', responseStatus: 'accepted' }], reminders: { useDefault: true } });
    const input = resource([...dates, 'SUMMARY:Master', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.test', 'ATTENDEE;CN=Other;PARTSTAT=ACCEPTED:mailto:other@example.test']);
    const patch = googlePatch(bodyOf(input, previous), previous);
    expect(Object.keys(patch)).toEqual(['attendees']);
    expect(patch.attendees?.[0]?.self).toBe(true);
    expect(googleSendUpdates(previous, patch)).toBe('all');
    expect(googleSendUpdates(previous, { ...patch, summary: 'new' })).toBe('none');
    expect(bodyOf(resource([...dates, 'ATTENDEE:mailto:other@example.test']), previous).attendees[0]).not.toHaveProperty('displayName');
  });
  test('organizers notify other attendees only for scheduling changes', () => {
    const organizer = StoredGoogleEvent.parse({ ...master, organizer: { self: true }, attendees: [{ email: 'guest@example.test' }] });
    for (const patch of [{ location: 'Office' }, { status: 'cancelled' as const }, { recurrence: [] }, { start: { date: '2026-11-02' } }, { attendees: [] }]) expect(googleSendUpdates(organizer, patch)).toBe('all');
    expect(googleSendUpdates(organizer, { summary: 'Rename', description: 'Notes' })).toBe('none');
    expect(googleSendUpdates(StoredGoogleEvent.parse({ ...organizer, attendees: [{ self: true }] }), { location: 'Office' })).toBe('none');
    expect(googleSendUpdates(StoredGoogleEvent.parse({ ...organizer, organizer: { self: false } }), { location: 'Office' })).toBe('none');
  });
});

describe('Google override diffs', () => {
  const moved = ['RECURRENCE-ID;VALUE=DATE:20261103', 'DTSTART;VALUE=DATE:20261104', 'DTEND;VALUE=DATE:20261105', 'SUMMARY:Moved'];
  test('new overrides use instances; changed stored overrides use their own id and etag', () => {
    const newOps = googleWriteOps(resource(base, [moved]), [stored(master)], 'UTC');
    expect(newOps.at(-1)).toMatchObject({ op: 'patchInstance', masterId: 'master', originalStart: { date: '2026-11-03' }, body: { summary: 'Moved' } });
    const ops = googleWriteOps(resource(base, [[...moved.slice(0, -1), 'SUMMARY:Edited']]), [stored(master), stored(override)], 'UTC');
    expect(ops.at(-1)).toMatchObject({ op: 'patch', eventId: 'exception', etag: '"exception"', body: { summary: 'Edited' } });
  });
  test('new overrides diff against the inherited instance and a summary-only exception does not notify', () => {
    const invited = { ...master, organizer: { self: true }, attendees: [{ email: 'guest@example.test', responseStatus: 'needsAction' }], reminders: { useDefault: true } };
    const unchanged = ['RECURRENCE-ID;VALUE=DATE:20261103', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104', 'SUMMARY:Master', 'ATTENDEE:mailto:guest@example.test'];
    const input = resource([...base, 'ATTENDEE:mailto:guest@example.test'], [unchanged]);
    expect(googleWriteOps(input, [stored(invited)], 'UTC')).toEqual([]);
    const changed = resource([...base, 'ATTENDEE:mailto:guest@example.test'], [[...unchanged.filter((line) => !line.startsWith('SUMMARY:')), 'SUMMARY:Special']]);
    expect(googleWriteOps(changed, [stored(invited)], 'UTC')).toEqual([{ op: 'patchInstance', masterId: 'master', originalStart: { date: '2026-11-03' }, body: { summary: 'Special' }, sendUpdates: 'none' }]);
  });
  test('cancelled overrides and newly added EXDATE cancel the instance', () => {
    const operations = googleWriteOps(resource(base, [[...moved, 'STATUS:CANCELLED']]), [stored(master), stored(override)], 'UTC');
    expect(operations.at(-1)).toMatchObject({ op: 'patch', eventId: 'exception', body: { status: 'cancelled' } });
    const excluded = googleWriteOps(resource([...base, 'EXDATE;VALUE=DATE:20261106']), [stored(master)], 'UTC');
    expect(excluded.at(-1)).toMatchObject({ op: 'patchInstance', originalStart: { date: '2026-11-06' }, body: { status: 'cancelled' } });
  });
  test('missing exceptions revert to the master at original start, including previously cancelled exceptions', () => {
    const operations = googleWriteOps(resource(base), [stored(master), stored(override)], 'UTC');
    expect(operations.at(-1)).toMatchObject({ op: 'patch', eventId: 'exception', body: { summary: 'Master', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } } });
    const cancelled = { ...override, status: 'cancelled' };
    expect(googleWriteOps(resource(base), [stored(master), stored(cancelled)], 'UTC').at(-1)).toMatchObject({ body: { status: 'confirmed' } });
  });
  test('reverted timed exceptions preserve the master wall duration across a DST boundary', () => {
    const event = { ...master, start: { dateTime: '2026-10-24T09:00:00+02:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-10-24T10:00:00+02:00', timeZone: 'Europe/Paris' } };
    const input = resource(['DTSTART;TZID=Europe/Paris:20261024T090000', 'DTEND;TZID=Europe/Paris:20261024T100000', 'SUMMARY:Master', 'RRULE:FREQ=DAILY;COUNT=10']);
    const ops = googleWriteOps(input, [{ id: event.id, etag: event.etag, payload: event }, { id: 'timed', etag: '2', payload: { ...event, id: 'timed', recurringEventId: 'master', originalStartTime: { dateTime: '2026-10-26T09:00:00+01:00' }, summary: 'Moved' } }], 'UTC');
    expect(ops.at(-1)).toMatchObject({ eventId: 'timed', body: { start: { dateTime: '2026-10-26T09:00:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-10-26T10:00:00', timeZone: 'Europe/Paris' } } });
  });
});
