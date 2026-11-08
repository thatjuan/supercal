/**
 * ICS fixtures for e2e, served by `serve.ts` on `E2E_FIXTURE_PORT`: the fixed "Team" calendar at
 * `/team.ics`, plus any calendar a test `PUT`s (built with `ics`); a later `PUT` is a source change
 * the next sync picks up.
 */
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const DAY_MS = 86_400_000;

function event(uid: string, summary: string, inDays: number): string {
  const start = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + inDays * DAY_MS + 9 * 3_600_000);
  return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + 3_600_000))}`, `SUMMARY:${summary}`, 'END:VEVENT'].join('\r\n');
}

/** The default calendar: "Team", with two events over the next days, so the first sync writes changes. */
export const ICS_FIXTURE = () =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Supercal//e2e//EN', 'X-WR-CALNAME:Team', event('standup@e2e', 'Standup', 1), event('review@e2e', 'Review', 2), 'END:VCALENDAR', ''].join('\r\n');

/** The fixture server's origin, from the port Playwright's config chose. */
export const fixtureOrigin = () => `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT}`;

const bodies = new Map<string, string>();

/** The fixture server's handler: `PUT` stores a calendar at its path, `GET` serves it (or the Team calendar). */
export async function fixtureResponse(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'PUT') {
    bodies.set(pathname, await request.text());
    return new Response(null, { status: 204 });
  }
  const body = bodies.get(pathname) ?? (pathname === '/team.ics' ? ICS_FIXTURE() : undefined);
  return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { headers: { 'content-type': 'text/calendar' } });
}

export type FixtureEvent = { uid: string; summary: string; start: Date; minutes: number; location?: string };

/** A VCALENDAR named `name` holding `events` (UTC times), for `PUT`ting to the fixture server. */
export function ics(name: string, events: FixtureEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Supercal//e2e//EN', `X-WR-CALNAME:${name}`];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(new Date(0))}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(new Date(e.start.getTime() + e.minutes * 60_000))}`,
      `SUMMARY:${e.summary}`,
      ...(e.location ? [`LOCATION:${e.location}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
