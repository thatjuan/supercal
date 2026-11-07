// tsdav against the feed spike: discovery, time-range fetch, webdav (sync-collection) smart sync
// across a server-side change, and recovery after an epoch bump.
import { calendarMultiGet, createDAVClient } from "tsdav";

const serverUrl = process.argv[2] ?? "http://localhost:5232/";
const mutate = (...args: string[]) => Bun.spawnSync(["bun", "src/mutate.ts", ...args], { cwd: new URL("..", import.meta.url).pathname });

const client = await createDAVClient({
  serverUrl,
  credentials: { username: "meridian", password: "meridian-app-pw" },
  authMethod: "Basic",
  defaultAccountType: "caldav",
});
const cals = await client.fetchCalendars();
console.log("calendars:", cals.map((c) => `${String(c.displayName)} ctag=${c.ctag} reports=${(c.reports ?? []).join(",")} comps=${(c.components ?? []).join(",")}`));
const work = cals.find((c) => c.url.endsWith("/work/"));
if (!work) throw new Error("no work calendar");

const ranged = await client.fetchCalendarObjects({ calendar: work, timeRange: { start: "2026-11-01T00:00:00Z", end: "2026-11-30T00:00:00Z" } });
console.log("time-range Nov 2026:", ranged.length, "objects");
const all = await client.fetchCalendarObjects({ calendar: work });
console.log("all:", all.length, "objects, first etag", all[0]?.etag);
// smartCollectionSync needs objectMultiGet on the collection to fetch changed hrefs
const withObjects = { ...work, objects: all, objectMultiGet: calendarMultiGet };

mutate("update", "1", "meeting-b@example.com", "Meeting B (edited for tsdav)");
mutate("delete", "1", "flight@example.com");
const s1 = await client.smartCollectionSyncDetailed({ collection: withObjects, method: "webdav" });
console.log("webdav sync: created", s1.objects.created.length, "updated", s1.objects.updated.length, "deleted", s1.objects.deleted.length, "new token", s1.syncToken);
console.log("  updated summaries:", s1.objects.updated.map((o) => /SUMMARY:(.*)/.exec(String(o.data))?.[1]));

mutate("bump-epoch", "1");
try {
  const s2 = await client.smartCollectionSyncDetailed({ collection: { ...work, syncToken: s1.syncToken, objects: all, objectMultiGet: calendarMultiGet }, method: "webdav" });
  console.log("after epoch bump: created", s2.objects.created.length, "updated", s2.objects.updated.length, "deleted", s2.objects.deleted.length, "token", s2.syncToken);
} catch (e) {
  console.log("after epoch bump, tsdav threw:", (e as Error).message.slice(0, 200));
}
const dirty = await client.isCollectionDirty({ collection: work });
console.log("isCollectionDirty (ctag compare) after changes:", dirty.isDirty, dirty.newCtag);
