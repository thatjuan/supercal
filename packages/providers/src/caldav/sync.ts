/**
 * CalDAV event sync for one collection, as raw pages for the runner:
 *
 * - `sync-collection` (RFC 6578): no token → a snapshot of every href; a token → a delta where 404
 *   entries are deletes. A truncated answer (507 on the collection) continues with the returned
 *   token in the same run; an invalid token (403 `valid-sync-token`) restarts as a snapshot; a
 *   definite 403/405/501 downgrades the collection to `etag` for as long as its cursor lives.
 * - `etag`: an unchanged ctag ends at once; otherwise a Depth 1 PROPFIND of etags is diffed against
 *   the cursor's map. It is a snapshot only without a previous map.
 *
 * Changed hrefs are multigot in batches of 100. Malformed, partial or incomplete answers throw
 * `ProviderUnavailableError` before any cursor exists, so an error never becomes a deletion.
 */
import { parseCalendar, serializeCalendar } from '@supercal/core';
import { z } from 'zod';
import { ProviderUnavailableError, type Logger, type RawObject, type SyncEnd, type SyncPage } from '../adapter.ts';
import type { Incremental } from './discovery.ts';
import { DavStatusError, Text, type DavSession } from './session.ts';

/** Hrefs whose object holds several UIDs (invalid, but seen in the wild), so their split ids can be deleted later. */
const Split = z.record(z.string(), z.array(z.string())).default({});

export const CaldavCursor = z.discriminatedUnion('mode', [
  z.object({ v: z.literal(1), mode: z.literal('sync'), token: z.string(), split: Split }),
  z.object({ v: z.literal(1), mode: z.literal('etag'), ctag: z.string().nullable(), etags: z.record(z.string(), z.string()), split: Split }),
]);
export type CaldavCursor = z.infer<typeof CaldavCursor>;
type SplitMap = z.infer<typeof Split>;
type Item = SyncPage | SyncEnd<CaldavCursor>;

const MULTIGET_BATCH = 100;
const MAX_UIDS_PER_OBJECT = 100;
const MAX_SYNC_ROUNDS = 1000;
const MAX_SYNC_HREFS = 200_000;

/** Thrown when the server definitely does not do sync-collection on this collection. */
class SyncUnsupported extends Error {}

/** A path with every segment percent-encoded the same way, so `a@b` and `a%40b` compare equal. */
export function canonicalPath(href: string): string {
  return new URL(href).pathname
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return segment;
      }
    })
    .join('/');
}

/** The raw object ids an href's object maps to: the path, or `path#uid` for each UID of a split object. */
const idsOf = (path: string, split: SplitMap) => split[path]?.map((uid) => `${path}#${uid}`) ?? [path];

/** One CalDAV object as raw objects, one per UID. Records (or clears) the href in `split`. */
export function rawObjects(path: string, etag: string, payload: string, split: SplitMap, log?: Logger): RawObject[] {
  const parsed = parseCalendar(payload);
  const uids = [...new Set(parsed.resources.map((resource) => resource.uid))];
  if (uids.length <= 1) {
    delete split[path];
    return uids.map((uid) => ({ id: path, etag, groupUid: uid, payload }));
  }
  if (uids.length > MAX_UIDS_PER_OBJECT) {
    delete split[path];
    log?.warn('skipping a CalDAV object with too many UIDs', { count: uids.length, limit: MAX_UIDS_PER_OBJECT });
    return [];
  }
  split[path] = uids;
  return parsed.resources.map((resource) => ({ id: `${path}#${resource.uid}`, etag, groupUid: resource.uid, payload: serializeCalendar({ props: [], resources: [resource] }) }));
}

/** Multigets `paths` in batches and yields one page each; the ids a changed href no longer has are deleted with it. */
async function* fetchChanged(dav: DavSession, collection: string, paths: string[], split: SplitMap): AsyncGenerator<SyncPage> {
  for (let i = 0; i < paths.length; i += MULTIGET_BATCH) {
    const batch = paths.slice(i, i + MULTIGET_BATCH);
    const result = await dav.multiget(collection, batch);
    const got = new Map<string, { etag: string; data: string }>();
    for (const entry of result.entries) {
      const etag = Text.safeParse(entry.props.getetag);
      const data = Text.safeParse(entry.props.calendarData);
      if (entry.status >= 200 && entry.status < 300 && etag.success && data.success) got.set(canonicalPath(entry.href), { etag: etag.data, data: data.data });
    }
    const missing = batch.filter((path) => !got.has(path)).length;
    if (missing) throw new ProviderUnavailableError(`calendar-multiget returned ${batch.length - missing} of ${batch.length} objects`);

    const upserts: RawObject[] = [];
    const deletes: string[] = [];
    for (const [path, { etag, data }] of got) {
      const before = idsOf(path, split);
      const objects = rawObjects(path, etag, data, split, dav.log);
      const now = new Set(objects.map((o) => o.id));
      upserts.push(...objects);
      deletes.push(...before.filter((id) => !now.has(id)));
    }
    yield { kind: 'page', upserts, deletes };
  }
}

/** Deletes every id of `paths` and forgets them in `split`. */
function deletesOf(paths: Iterable<string>, split: SplitMap): string[] {
  return [...paths].flatMap((path) => {
    const ids = idsOf(path, split);
    delete split[path];
    return ids;
  });
}

/** An href's canonical path as a collection path (trailing slash). */
const dirPath = (href: string) => canonicalPath(href).replace(/\/?$/, '/');

/** Whether a canonical path is a member of the collection (not the collection itself). */
const childOf = (collection: string) => {
  const base = dirPath(collection);
  return (path: string) => path.startsWith(base) && path !== base;
};

async function* viaSyncCollection(dav: DavSession, collection: string, cursor: Extract<CaldavCursor, { mode: 'sync' }> | null): AsyncGenerator<Item> {
  let token = cursor?.token ?? '';
  let snapshot = cursor === null;
  let split: SplitMap = { ...cursor?.split };
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const isChild = childOf(collection);
  const self = dirPath(collection);
  let rounds = 0;
  let restarted = false;
  const unfinished = () => new ProviderUnavailableError('the CalDAV server never finished its sync-collection answer');

  for (;;) {
    if (++rounds > MAX_SYNC_ROUNDS || changed.size + deleted.size > MAX_SYNC_HREFS) throw unfinished();
    let result;
    try {
      result = await dav.syncCollection(collection, token, [403, 405, 501]);
    } catch (error) {
      if (!(error instanceof DavStatusError)) throw error;
      if (error.status === 403 && /valid-sync-token/.test(error.body)) {
        if (!token || restarted) throw unfinished();
        restarted = true;
        rounds = 0;
        token = '';
        snapshot = true;
        split = {};
        changed.clear();
        deleted.clear();
        continue;
      }
      throw new SyncUnsupported();
    }
    if (!result.syncToken) throw new ProviderUnavailableError('the sync-collection answer has no sync-token');
    let truncated = false;
    for (const entry of result.entries) {
      const path = canonicalPath(entry.href);
      if (dirPath(entry.href) === self) {
        truncated ||= entry.status === 507;
        continue;
      }
      if (!isChild(path)) continue;
      if (entry.status === 404) {
        deleted.add(path);
        changed.delete(path);
      } else if (entry.status >= 200 && entry.status < 300 && Text.safeParse(entry.props.getetag).success) {
        changed.add(path);
        deleted.delete(path);
      } else {
        throw new ProviderUnavailableError(`the sync-collection answer is incomplete (status ${entry.status})`);
      }
    }
    if (changed.size + deleted.size > MAX_SYNC_HREFS) throw unfinished();
    token = result.syncToken;
    if (!truncated) break;
  }

  yield* fetchChanged(dav, collection, [...changed], split);
  if (deleted.size) yield { kind: 'page', upserts: [], deletes: deletesOf(deleted, split) };
  yield { kind: 'end', mode: snapshot ? 'snapshot' : 'delta', cursor: { v: 1, mode: 'sync', token, split } };
}

async function* viaEtags(dav: DavSession, collection: string, cursor: Extract<CaldavCursor, { mode: 'etag' }> | null): AsyncGenerator<Item> {
  const meta = await dav.propfind(collection, ['cs:getctag'], '0');
  const ctagEntry = meta.entries.find((e) => dirPath(e.href) === dirPath(collection));
  const ctag = Text.safeParse(ctagEntry?.props.getctag).data ?? null;
  // Without a ctag nothing can be skipped.
  if (cursor && ctag !== null && ctag === cursor.ctag) {
    yield { kind: 'end', mode: 'delta', cursor };
    return;
  }

  const listing = await dav.propfind(collection, ['d:getetag', 'd:resourcetype'], '1');
  const isChild = childOf(collection);
  const etags: Record<string, string> = {};
  for (const entry of listing.entries) {
    const path = canonicalPath(entry.href);
    if (!isChild(path)) continue;
    const type = z.record(z.string(), z.unknown()).safeParse(entry.props.resourcetype).data;
    if (type && 'collection' in type) continue;
    const etag = Text.safeParse(entry.props.getetag);
    if (!etag.success || entry.status < 200 || entry.status >= 300) throw new ProviderUnavailableError(`the etag listing is incomplete (status ${entry.status})`);
    etags[path] = etag.data;
  }

  const split: SplitMap = cursor ? { ...cursor.split } : {};
  const changed = Object.keys(etags).filter((path) => cursor?.etags[path] !== etags[path]);
  const deleted = cursor ? Object.keys(cursor.etags).filter((path) => !(path in etags)) : [];
  yield* fetchChanged(dav, collection, changed, split);
  if (deleted.length) yield { kind: 'page', upserts: [], deletes: deletesOf(deleted, split) };
  // The listing's etags, not the multiget's: a change made in between is seen next time.
  yield { kind: 'end', mode: cursor ? 'delta' : 'snapshot', cursor: { v: 1, mode: 'etag', ctag, etags, split } };
}

/**
 * Syncs one collection. A stored cursor that does not parse starts over as a snapshot; an `etag`
 * cursor keeps the collection on etags even when it advertises sync-collection.
 */
export async function* syncCollection(dav: DavSession, collection: string, incremental: Incremental, stored: unknown): AsyncGenerator<Item> {
  const cursor = CaldavCursor.safeParse(stored).data ?? null;
  if (cursor?.mode === 'etag' || incremental === 'etag') {
    yield* viaEtags(dav, collection, cursor?.mode === 'etag' ? cursor : null);
    return;
  }
  try {
    yield* viaSyncCollection(dav, collection, cursor?.mode === 'sync' ? cursor : null);
  } catch (error) {
    if (!(error instanceof SyncUnsupported)) throw error;
    yield* viaEtags(dav, collection, null);
  }
}
