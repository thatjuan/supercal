import { expect, test } from 'bun:test';
import { createLogger, redact } from './log.ts';

test.each([
  ['https://cal.example.com/ics/tok123/feed.ics?key=abc#x', 'https://cal.example.com/ics/…?…#…'],
  ['https://user:pass@example.com/calendar.ics', 'https://example.com/calendar.ics'],
  ['/ics/tok123', '/ics/…'],
  ['/dav/calendars/home?depth=1', '/dav/calendars/home?…'],
  ['ya29.secret-token', '…'],
])('redact(%p)', (input, expected) => {
  expect(redact(input)).toBe(expected);
});

test('child loggers add context to JSON lines', () => {
  const lines: string[] = [];
  createLogger({ app: 'supercal' }, (line) => lines.push(line)).child({ role: 'worker' }).warn('slow', { ms: 12 });
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'warn', msg: 'slow', app: 'supercal', role: 'worker', ms: 12 });
});
