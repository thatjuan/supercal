/** Google Calendar event JSON, ported from the ingest spike (`spikes/ingest/test/mapping.test.ts`). */
import type { GoogleEvent } from "../../src/index.ts";

export const weeklyMaster: GoogleEvent = {
  id: "series",
  iCalUID: "series@example.test",
  updated: "2026-11-07T00:00:00Z",
  summary: "Weekly; team, sync\nNew line",
  start: { dateTime: "2026-10-26T09:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-26T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"],
  conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] },
};

/** The 2 Nov instance, moved two hours later (across the DST change). */
export const movedInstance: GoogleEvent = {
  id: "series_20261102T170000Z",
  iCalUID: "series@example.test",
  recurringEventId: "series",
  originalStartTime: { dateTime: "2026-11-02T09:00:00-08:00", timeZone: "America/Los_Angeles" },
  start: { dateTime: "2026-11-02T11:00:00-08:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-11-02T12:00:00-08:00", timeZone: "America/Los_Angeles" },
  summary: "Moved",
};

/** The 9 Nov instance, cancelled: sparse, as incremental sync sends it. */
export const sparseCancelled: GoogleEvent = {
  id: "series_20261109T170000Z",
  status: "cancelled",
  recurringEventId: "series",
  originalStartTime: { dateTime: "2026-11-09T09:00:00-08:00" },
};

export const allDay: GoogleEvent = { id: "day", iCalUID: "day@example.test", start: { date: "2026-11-10" }, end: { date: "2026-11-12" } };
