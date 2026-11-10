import { describe, expect, test } from 'bun:test';
import { MAX_OBJECT_BYTES, validateObject } from '../src/hosted.ts';

const calendar = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const event = (lines = 'DTSTART:20261110T090000Z') => `BEGIN:VEVENT\r\nUID:u1\r\n${lines}\r\nEND:VEVENT`;

describe('hosted object validation', () => {
  test('accepts a timed VEVENT and its alarms, preserving unknown properties', () => {
    expect(validateObject(calendar(event('DTSTART:20261110T090000Z\r\nX-CUSTOM:yes\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nEND:VALARM'))).ok).toBe(true);
  });
  test('accepts an unknown TZID when the object supplies its VTIMEZONE', () => {
    const timezone = ['BEGIN:VTIMEZONE', 'TZID:Custom/Local', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0230', 'TZOFFSETTO:+0230', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
    expect(validateObject(calendar(`${timezone}\r\n${event('DTSTART;TZID=Custom/Local:20261110T090000')}`)).ok).toBe(true);
  });
  test('invalid-calendar-data: malformed components, missing timing and unknown zones', () => {
    for (const payload of [calendar(event().replace('END:VEVENT', 'END:VTODO')), calendar(event('SUMMARY:No start')), calendar(event('DTSTART;TZID=Mars/Olympus:20261110T090000')), calendar(event('DTSTART:garbage')), event()])
      expect(validateObject(payload)).toMatchObject({ ok: false, code: 'invalid-calendar-data' });
  });
  test('unsupported-component: VTODO-only and mixed calendars', () => {
    for (const component of ['VTODO', 'VJOURNAL', 'VFREEBUSY', 'VUNKNOWN'])
      expect(validateObject(calendar(`BEGIN:${component}\r\nUID:u1\r\nEND:${component}`))).toMatchObject({ ok: false, code: 'unsupported-component' });
    expect(validateObject(calendar(`${event()}\r\nBEGIN:VTODO\r\nEND:VTODO`))).toMatchObject({ ok: false, code: 'unsupported-component' });
  });
  test('invalid-object: METHOD, zero events and multiple UIDs', () => {
    for (const payload of [calendar(`METHOD:REQUEST\r\n${event()}`), calendar(''), calendar(`${event()}\r\n${event().replace('UID:u1', 'UID:u2')}`)])
      expect(validateObject(payload)).toMatchObject({ ok: false, code: 'invalid-object' });
  });
  test('rejects overrides carrying their own expensive RRULE without expanding each', () => {
    const overrides = Array.from({ length: 8 }, (_, n) => event(`RECURRENCE-ID:202611${10 + n}T090000Z\r\nDTSTART:202611${10 + n}T100000Z\r\nRRULE:FREQ=DAILY;COUNT=20000`)).join('\r\n');
    const started = performance.now();
    expect(validateObject(calendar(`${event()}\r\n${overrides}`))).toMatchObject({ ok: false, detail: 'An override cannot carry RRULE' });
    expect(performance.now() - started).toBeLessThan(2000);
  }, 2000);
  test('accepts a recurring master with ordinary overrides', () => {
    const master = event('DTSTART:20261110T090000Z\r\nRRULE:FREQ=DAILY;COUNT=10');
    const override = event('RECURRENCE-ID:20261111T090000Z\r\nDTSTART:20261111T100000Z');
    expect(validateObject(calendar(`${master}\r\n${override}`)).ok).toBe(true);
  });
  test('too-large counts UTF-8 bytes', () => {
    expect(validateObject('é'.repeat(MAX_OBJECT_BYTES / 2 + 1))).toMatchObject({ ok: false, code: 'too-large' });
  });
});
