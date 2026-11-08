/** The e2e's ICS calendar: "Team", with two events over the next days, so the first sync writes changes. */
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const DAY_MS = 86_400_000;

function event(uid: string, summary: string, inDays: number): string {
  const start = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS + inDays * DAY_MS + 9 * 3_600_000);
  return ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + 3_600_000))}`, `SUMMARY:${summary}`, 'END:VEVENT'].join('\r\n');
}

export const ICS_FIXTURE = () =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Supercal//e2e//EN', 'X-WR-CALNAME:Team', event('standup@e2e', 'Standup', 1), event('review@e2e', 'Review', 2), 'END:VCALENDAR', ''].join('\r\n');
