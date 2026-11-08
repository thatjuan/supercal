/** Microsoft Graph event JSON (as fetched with `Prefer: outlook.timezone="UTC"`), ported from the ingest spike (`spikes/ingest/test/mapping.test.ts`). */
import type { GraphEvent } from "../../src/index.ts";

/** Weekly on Mondays 09:00 Pacific, five times, from 26 Oct 2026 (before the DST change). */
export const weeklyMaster: GraphEvent = {
  id: "master",
  type: "seriesMaster",
  iCalUId: "master@example.test",
  subject: "Team sync",
  start: { dateTime: "2026-10-26T16:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-10-26T17:00:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "Pacific Standard Time",
  recurrence: {
    pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"], firstDayOfWeek: "sunday", dayOfMonth: 0, month: 0, index: "first" },
    range: { type: "numbered", startDate: "2026-10-26", endDate: "0001-01-01", numberOfOccurrences: 5, recurrenceTimeZone: "Pacific Standard Time" },
  },
  cancelledOccurrences: ["opaque-cancelled-id"],
  lastModifiedDateTime: "2026-11-07T00:00:00Z",
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/fixture" },
};

/** The 2 Nov occurrence, moved two hours later; Graph gives each occurrence its own iCalUId. */
export const movedException: GraphEvent = {
  id: "instance",
  type: "exception",
  iCalUId: "DIFFERENT-UID",
  seriesMasterId: "master",
  originalStart: "2026-11-02T17:00:00Z",
  start: { dateTime: "2026-11-02T19:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-02T20:00:00.0000000", timeZone: "UTC" },
  subject: "Moved",
};

/** An all-day single event created in Tokyo, returned in UTC (so it starts the previous UTC day). */
export const tokyoDay: GraphEvent = {
  id: "tokyo-day",
  type: "singleInstance",
  iCalUId: "tokyo@example.test",
  isAllDay: true,
  originalStartTimeZone: "Tokyo Standard Time",
  start: { dateTime: "2026-11-09T15:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-10T15:00:00.0000000", timeZone: "UTC" },
};
