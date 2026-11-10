/** Graph's field and recurrence conversion must survive its own ingest normalizer. */
import { getProp, normalizeGraph, parseCalendar, type EventResource } from '@supercal/core';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { graphEventBody, graphWriteOps, graphUtcBody } from '../src/microsoft/write.ts';
import { ProviderWriteRejectedError } from '../src/adapter.ts';

/** Build one UID group for a pure conversion test. */
function resource(lines: string[]): EventResource {
  const parsed = parseCalendar(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:device@test', 'DTSTAMP:20261101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
  if (!parsed.resources[0]) throw new Error(JSON.stringify(parsed.errors));
  return parsed.resources[0];
}
/** Convert then normalize the exact fields returned by Graph. */
function roundTrip(input: EventResource) {
  const op = graphWriteOps(input, [], 'America/Vancouver')[0];
  if (op?.op !== 'create') throw new Error('expected create');
  const json = { ...op.body, id: 'graph', iCalUId: 'graph@test' };
  const normalized = normalizeGraph([{ id: 'graph', etag: 'key', groupUid: 'graph@test', payload: JSON.stringify(json) }]);
  if (!normalized?.resource.master) throw new Error('missing normalized master');
  return { body: op.body, next: graphEventBody(normalized.resource.master, normalized.resource, 'America/Vancouver'), master: normalized.resource.master };
}

test('mapped fields, attendees, reminder, local times and duration round-trip', () => {
  const result = roundTrip(resource(['DTSTART;TZID=Europe/Paris:20261109T090000', 'DURATION:PT1H', 'SUMMARY:Planning', 'DESCRIPTION:Notes\\nSecond line', 'LOCATION:Office', 'STATUS:TENTATIVE', 'CLASS:CONFIDENTIAL', 'ATTENDEE;CN=Grace;ROLE=OPT-PARTICIPANT:mailto:grace@example.test', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM']));
  const { recurrence: _recurrence, ...fields } = result.body;
  expect(result.next).toEqual(fields);
  expect(result.body).toMatchObject({ showAs: 'tentative', isReminderOn: true, reminderMinutesBeforeStart: 15, end: { dateTime: '2026-11-09T10:00:00', timeZone: 'Europe/Paris' } });
});
test.each(['CLASS:PRIVATE', 'TRANSP:TRANSPARENT', ''])('privacy and availability round-trip: %s', (extra) => {
  const result = roundTrip(resource(['DTSTART:20261109T090000Z', 'DURATION:PT1H', ...(extra ? [extra] : [])]));
  const { recurrence: _r, ...fields } = result.body;
  expect(result.next).toEqual(fields);
});
test('all-day midnight and floating times use calendar zone', () => {
  const allDay = roundTrip(resource(['DTSTART;VALUE=DATE:20261109']));
  expect(allDay.body).toMatchObject({ isAllDay: true, start: { dateTime: '2026-11-09T00:00:00', timeZone: 'America/Vancouver' }, end: { dateTime: '2026-11-10T00:00:00', timeZone: 'America/Vancouver' }, isReminderOn: false });
  expect(getProp(allDay.master, 'dtstart')?.[2]).toBe('date');
  const floating = roundTrip(resource(['DTSTART:20261109T090000', 'DURATION:PT90M']));
  expect(floating.body.end).toEqual({ dateTime: '2026-11-09T10:30:00', timeZone: 'America/Vancouver' });
});
test('unchanged HTML description preserves formatting on other edits', () => {
  const input = resource(['DTSTART:20261109T090000Z', 'DESCRIPTION:Hello & goodbye']);
  const existing = { id: 'one', start: { dateTime: '2026-11-09T09:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-09T10:00:00', timeZone: 'UTC' }, body: { contentType: 'html', content: '<b>Hello &amp; goodbye</b>' } };
  expect(graphEventBody(input.master!, input, 'UTC', existing)).not.toHaveProperty('body');
  expect(graphEventBody(input.master!, input, 'UTC', { ...existing, body: { ...existing.body, content: 'Different' } }).body).toEqual({ contentType: 'text', content: 'Hello & goodbye' });
});
test.each(['FREQ=DAILY;COUNT=4', 'FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'FREQ=MONTHLY;BYMONTHDAY=9', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2', 'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=9', 'FREQ=YEARLY;BYMONTH=11;BYDAY=MO;BYSETPOS=2', 'FREQ=DAILY;UNTIL=20261120T235959Z'])('recurrence round-trips: %s', (rule) => {
  const input = resource(['DTSTART:20261109T090000Z', 'DURATION:PT1H', `RRULE:${rule}`]);
  const result = roundTrip(input);
  expect(result.body.recurrence).toBeTruthy();
  // The normalized master must be accepted by the inverse with identical recurrence data.
  const normalized = normalizeGraph([{ id: 'graph', etag: 'key', groupUid: 'graph@test', payload: JSON.stringify({ ...result.body, id: 'graph' }) }])!;
  expect(graphWriteOps(normalized.resource, [], 'UTC')[0]).toMatchObject({ body: { recurrence: result.body.recurrence } });
});
test.each(['RRULE:FREQ=HOURLY', 'RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261120T000000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,2', 'RRULE:FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1', 'RRULE:FREQ=DAILY\r\nRRULE:FREQ=WEEKLY', 'RDATE:20261120T090000Z', 'RRULE:FREQ=DAILY;BYDAY=MO', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1'])('unrepresentable recurrence is refused: %s', (rule) => {
  expect(() => graphWriteOps(resource(['DTSTART:20261109T090000Z', rule]), [], 'UTC')).toThrow(ProviderWriteRejectedError);
});

test('unchanged masters avoid notifications, new exceptions address slots, and removed exceptions restore wall duration and HTML', () => {
  const input = resource(['DTSTART;TZID=Europe/Paris:20261024T090000', 'DURATION:PT1H', 'DESCRIPTION:Hello', 'RRULE:FREQ=DAILY;COUNT=10']);
  const op = graphWriteOps(input, [], 'UTC')[0];
  if (op?.op !== 'create') throw new Error('expected create');
  const master = { ...op.body, id: 'master', iCalUId: input.uid, type: 'seriesMaster', body: { contentType: 'html', content: '<b>Hello</b>' }, originalStartTimeZone: 'Europe/Paris' };
  const stored = [{ id: 'master', etag: 'k1', payload: z.json().parse(JSON.parse(JSON.stringify(master))) }];
  expect(graphWriteOps(input, stored, 'UTC')).toEqual([]);
  const exception = { ...master, id: 'exception', type: 'exception', seriesMasterId: 'master', originalStart: '2026-10-26T08:00:00Z', start: { dateTime: '2026-10-26T12:00:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-10-26T13:00:00', timeZone: 'Europe/Paris' }, body: { contentType: 'text', content: 'Different' }, recurrence: null };
  const ops = graphWriteOps(input, [...stored, { id: 'exception', etag: 'k2', originalStart: exception.originalStart, payload: z.json().parse(JSON.parse(JSON.stringify(exception))) }], 'UTC');
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({ op: 'instance', masterId: 'master', originalStart: exception.originalStart, body: { start: { dateTime: '2026-10-26T09:00:00' }, end: { dateTime: '2026-10-26T10:00:00' }, body: { contentType: 'html', content: '<b>Hello</b>' } } });
});


test('UTC fallback keeps all-day recurrence dates at midnight', () => {
  const result = roundTrip(resource(['DTSTART;VALUE=DATE:20261109', 'RRULE:FREQ=DAILY;COUNT=5']));
  const body = graphUtcBody(result.body);
  expect(body.start).toEqual({ dateTime: '2026-11-09T00:00:00', timeZone: 'UTC' });
  const normalized = normalizeGraph([{ id: 'one', etag: 'key', groupUid: 'graph@test', payload: JSON.stringify({ ...body, id: 'one', originalStartTimeZone: 'America/Vancouver' }) }]);
  expect(getProp(normalized!.resource.master!, 'dtstart')?.[3]).toBe('2026-11-09');
});
