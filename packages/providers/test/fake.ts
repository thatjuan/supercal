/**
 * An in-memory provider for sync-engine tests. Each calendar keeps its objects and a change log,
 * so a sync with a cursor is a delta of what changed since, and one without is a snapshot (or every
 * sync is, with `mode: 'snapshot'`). Tests script failures, throttling, delays and pauses:
 *
 *   const fake = createFakeAdapter({ pageSize: 2 });
 *   fake.calendar('work').put('a', fakeEvent('a@test'));
 *   fake.fail({ calendar: 'work', at: 2, error: new ProviderUnavailableError('boom') });
 *   fake.hooks.beforeItem = async (calendar, item) => { if (item.kind === 'end') await paused; };
 */
import type { AccountProvider } from '@supercal/db';
import {
  ProviderUnavailableError,
  type AdapterContext,
  type ProviderAdapter,
  type SourceCalendarInfo,
  type SyncEnd,
  type SyncPage,
} from '../src/index.ts';

export type FakeObject = { groupUid: string; payload: string; etag?: string; originalStart?: string };
export type FakeCursor = { v: 1; version: number; etags: Record<string, string> };
type Item = SyncPage | SyncEnd<FakeCursor>;

/** Where a scripted failure fires: listing calendars, before page `n` (1-based) of a sync, or before its end. */
export type FaultSite = 'list' | number | 'end';
type Fault = { calendar: string | undefined; at: FaultSite; error: Error; times: number };

class FakeCalendar {
  readonly objects = new Map<string, FakeObject & { etag: string }>();
  /** Object ids by the version that last changed them. */
  private readonly changes: { version: number; id: string }[] = [];
  version = 0;

  constructor(public info: SourceCalendarInfo) {}

  /** Creates or replaces an object; its etag defaults to a hash of the payload. */
  put(id: string, object: FakeObject): this {
    this.objects.set(id, { ...object, etag: object.etag ?? Bun.hash(object.payload).toString(36) });
    this.changes.push({ version: ++this.version, id });
    return this;
  }

  remove(id: string): this {
    this.objects.delete(id);
    this.changes.push({ version: ++this.version, id });
    return this;
  }

  changedSince(version: number): string[] {
    return [...new Set(this.changes.filter((c) => c.version > version).map((c) => c.id))];
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/**
 * Builds a fake adapter for `provider` (default `ics`, format `ical`). `touchUnchanged` makes
 * snapshots send unchanged objects as touches, as the Microsoft reconciliation does.
 */
export function createFakeAdapter({
  provider = 'ics' as AccountProvider,
  mode = 'delta' as 'delta' | 'snapshot',
  pageSize = 50,
  delayMs = 0,
  touchUnchanged = false,
} = {}) {
  const calendars = new Map<string, FakeCalendar>();
  const faults: Fault[] = [];
  const syncs = new Map<string, number>();
  /** `beforeItem` is awaited before each page or end is yielded; for pausing a run mid-sync. */
  const hooks: { beforeItem?: (calendar: string, item: Item) => Promise<void> } = {};

  const fire = (calendar: string | undefined, at: FaultSite) => {
    const fault = faults.find((f) => f.at === at && f.times > 0 && (f.calendar === undefined || f.calendar === calendar));
    if (!fault) return;
    fault.times--;
    throw fault.error;
  };

  const fake = {
    calendars,
    /** How many syncs each calendar has started. */
    syncs,
    hooks,

    /** The calendar with `providerCalendarId`, created (and listed from now on) on first use. */
    calendar(providerCalendarId: string, info: Partial<SourceCalendarInfo> = {}): FakeCalendar {
      let found = calendars.get(providerCalendarId);
      if (!found) {
        found = new FakeCalendar({ providerCalendarId, name: providerCalendarId, color: null, timezone: null, capabilities: { incremental: mode, push: false }, ...info });
        calendars.set(providerCalendarId, found);
      }
      return found;
    },

    /** Throws `error` at `at` the next `times` times (default once), for one calendar or any. */
    fail({ calendar, at, error, times = 1 }: { calendar?: string; at: FaultSite; error: Error; times?: number }) {
      faults.push({ calendar, at, error, times });
    },

    adapter: {
      provider,
      format: 'ical',
      capabilities: { calendarDiscovery: 'poll', push: 'none' },

      async listCalendars(): Promise<SourceCalendarInfo[]> {
        fire(undefined, 'list');
        return [...calendars.values()].map((c) => c.info);
      },

      async *sync(ctx: AdapterContext, ref, cursor) {
        const id = ref.providerCalendarId;
        syncs.set(id, (syncs.get(id) ?? 0) + 1);
        const calendar = calendars.get(id);
        if (!calendar) throw new ProviderUnavailableError(`no calendar ${id}`);
        const version = calendar.version;
        const etags = Object.fromEntries([...calendar.objects].map(([key, o]) => [key, o.etag]));
        const snapshot = mode === 'snapshot' || cursor === null;
        const ids = snapshot ? [...calendar.objects.keys()] : calendar.changedSince(cursor.version);

        const entries = ids.map((key) => {
          const object = calendar.objects.get(key);
          if (!object) return { delete: key };
          const touch = snapshot && touchUnchanged && cursor?.etags[key] === object.etag;
          return { upsert: { id: key, etag: object.etag, groupUid: object.groupUid, payload: touch ? null : object.payload, ...(object.originalStart && { originalStart: object.originalStart }) } };
        });
        const pages: SyncPage[] = [];
        for (let i = 0; i < entries.length; i += pageSize) {
          const chunk = entries.slice(i, i + pageSize);
          pages.push({ kind: 'page', upserts: chunk.flatMap((e) => (e.upsert ? [e.upsert] : [])), deletes: chunk.flatMap((e) => (e.delete ? [e.delete] : [])) });
        }

        const items: Item[] = [...pages, { kind: 'end', mode: snapshot ? 'snapshot' : 'delta', cursor: { v: 1, version, etags } }];
        for (const [index, item] of items.entries()) {
          if (delayMs) await sleep(delayMs, ctx.signal);
          await hooks.beforeItem?.(id, item);
          fire(id, item.kind === 'end' ? 'end' : index + 1);
          yield item;
        }
      },
    } satisfies ProviderAdapter<FakeCursor>,
  };
  return fake;
}

export type FakeProvider = ReturnType<typeof createFakeAdapter>;

/** A one-event VCALENDAR with `uid`, starting at `start` for an hour. */
export function fakeEvent(uid: string, { summary = uid, start = '20261201T100000Z', sequence = 0 } = {}): FakeObject {
  const end = start.replace(/T(\d\d)/, (_, h: string) => `T${String(Number(h) + 1).padStart(2, '0')}`);
  const payload = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Supercal fake//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    `SEQUENCE:${sequence}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return { groupUid: uid, payload };
}
