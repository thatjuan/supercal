/**
 * tsdav against the daemon: discovery, then `smartCollectionSync` (webdav sync-collection) across a
 * server-side update and delete, and recovery after an epoch bump. Run by clients.e2e.ts with
 * DAV_URL, DAV_USER, DAV_PASS and MUTATE set. tsdav quirk: the collection needs
 * `objectMultiGet: calendarMultiGet` set by hand.
 */
import { calendarMultiGet, createDAVClient } from 'tsdav';

const env = (key: string) => process.env[key] ?? (() => { throw new Error(`${key} is required`); })();
const mutate = (...args: string[]) => {
  if (Bun.spawnSync(['bun', env('MUTATE'), ...args]).exitCode !== 0) throw new Error(`mutate ${args.join(' ')} failed`);
};
const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

const client = await createDAVClient({
  serverUrl: env('DAV_URL'),
  credentials: { username: env('DAV_USER'), password: env('DAV_PASS') },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
});
const cals = await client.fetchCalendars();
console.log('calendars:', cals.map((c) => `${String(c.displayName)} reports=${(c.reports ?? []).join(',')} comps=${(c.components ?? []).join(',')}`));
const work = cals.find((c) => c.url.endsWith('/work/'));
if (!work) throw new Error('no work calendar');
check(cals.length === 4, `expected 4 calendars, got ${cals.length}`);
check((work.reports ?? []).includes('syncCollection'), 'sync-collection not advertised');

const objects = await client.fetchCalendarObjects({ calendar: work });
check(objects.length === 4, `expected 4 objects, got ${objects.length}`);
const collection = { ...work, objects, objectMultiGet: calendarMultiGet };

mutate('put', 'work', 'meeting@example.com', 'Shared meeting (edited)');
mutate('delete', 'work', 'floating@example.com');
const s1 = await client.smartCollectionSyncDetailed({ collection, method: 'webdav' });
const counts = (s: { objects: Record<'created' | 'updated' | 'deleted', unknown[]> }) => [s.objects.created.length, s.objects.updated.length, s.objects.deleted.length];
console.log('webdav sync: created/updated/deleted', counts(s1), 'token', s1.syncToken);
check(JSON.stringify(counts(s1)) === '[0,1,1]', 'incremental sync should update one and delete one');
check(s1.objects.updated.some((o) => String(o.data).includes('SUMMARY:Shared meeting (edited)')), 'updated body missing');

mutate('bump-epoch', 'work');
const s2 = await client.smartCollectionSyncDetailed({ collection: { ...collection, syncToken: String(s1.syncToken) }, method: 'webdav' });
console.log('after epoch bump: created/updated/deleted', counts(s2), 'token', s2.syncToken);
check(String(s2.syncToken).split('/').at(-2) === '1', 'token should carry the new epoch');

const dirty = await client.isCollectionDirty({ collection: work });
check(dirty.isDirty, 'ctag should have changed');
console.log('OK');
