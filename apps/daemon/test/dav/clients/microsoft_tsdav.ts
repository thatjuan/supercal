/** Exercise a real tsdav create/refetch/delete against the in-process Graph mock daemon. */
import { createDAVClient } from 'tsdav';

/** Graph assigns a new UID, while tsdav must still see the filename it chose. */
export async function verifyGraphUidWithTsdav(serverUrl: string, calendarId: string) {
  const client = await createDAVClient({ serverUrl, credentials: { username: 'microsoft-writer-abcdefgh', password: 'device-password' }, authMethod: 'Basic', defaultAccountType: 'caldav' });
  const calendar = (await client.fetchCalendars()).find((c) => c.url.endsWith(`/${calendarId}/`));
  if (!calendar) throw new Error('Microsoft calendar not discovered');
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:tsdav-client@test\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:20261109T090000Z\r\nDURATION:PT1H\r\nSUMMARY:tsdav\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const created = await client.createCalendarObject({ calendar, filename: 'tsdav-chosen.ics', iCalString: ics });
  if (created.status !== 201 || created.headers.has('etag')) throw new Error(`Unexpected create response: ${created.status}`);
  const object = (await client.fetchCalendarObjects({ calendar })).find((o) => o.url.endsWith('/tsdav-chosen.ics'));
  if (!object || !String(object.data).includes('@outlook.test') || String(object.data).includes('UID:tsdav-client@test')) throw new Error('Graph UID or client href lost');
  if ((await client.deleteCalendarObject({ calendarObject: object })).status !== 204) throw new Error('tsdav delete failed');
}
