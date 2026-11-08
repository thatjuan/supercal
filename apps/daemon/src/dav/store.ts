/**
 * What the CalDAV handlers read: the feed behind a login, its enabled publications as projection
 * specs, the per-publication object index (href → UID, ETag) built without rendering, and
 * rendered objects. Everything except `loginByUsername` takes the request's `TenantTx`.
 */
import { addMissingTimezones, hrefFor, objectEtag, project, serializeCalendar, type ProjectedObject, type PublicationSpec, type SourceResource } from '@supercal/core';
import {
  calendarAccount,
  feed,
  publication,
  publicationSource,
  publicationState,
  resource,
  resourcesByUids,
  sourceCalendar,
  user,
  withControl,
  type Feed,
  type FeedId,
  type LiveResource,
  type Publication,
  type SecretBox,
  type SourceCalendarId,
  type TenantTx,
} from '@supercal/db';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import { openUidSecret } from '../feeds/credentials.ts';
import type { FeedLogin } from './auth.ts';

/** The feed login for `username`, read as `supercal_control` before the tenant is known. */
export async function loginByUsername(username: string): Promise<FeedLogin | null> {
  const [row] = await withControl((tx) =>
    tx
      .select({ feedId: feed.id, tenantId: feed.tenantId, passwordHash: feed.caldavPasswordHash })
      .from(feed)
      .where(eq(feed.caldavUsername, username)),
  );
  return row?.passwordHash ? { ...row, passwordHash: row.passwordHash } : null;
}

type Source = { id: SourceCalendarId; priority: number; ownerAddresses: string[] };

/** An enabled publication with what projecting it needs. */
export type Pub = Publication & { spec: PublicationSpec; sources: Source[]; sourceIds: SourceCalendarId[] };

export type FeedAccount = { feed: Feed; ownerEmail: string | null; publications: Pub[] };

/** The feed, its owner's email and its enabled publications by `sort_order`; null when the feed is gone. */
export async function loadAccount(tx: TenantTx, secrets: SecretBox, feedId: FeedId): Promise<FeedAccount | null> {
  const [row] = await tx.select({ feed, email: user.email }).from(feed).leftJoin(user, eq(user.id, feed.ownerUserId)).where(eq(feed.id, feedId));
  if (!row) return null;
  const pubs = await tx
    .select()
    .from(publication)
    .where(and(eq(publication.feedId, feedId), eq(publication.enabled, true)))
    .orderBy(asc(publication.sortOrder), asc(publication.id));
  const sources = pubs.length
    ? await tx
        .select({ publicationId: publicationSource.publicationId, id: publicationSource.sourceCalendarId, priority: publicationSource.priority, email: calendarAccount.email })
        .from(publicationSource)
        .innerJoin(sourceCalendar, eq(sourceCalendar.id, publicationSource.sourceCalendarId))
        .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
        .where(inArray(publicationSource.publicationId, pubs.map((p) => p.id)))
        .orderBy(asc(publicationSource.priority))
    : [];
  const uidSecret = await openUidSecret(secrets, row.feed, tx);
  const publications = pubs.map((p): Pub => {
    const own = sources
      .filter((s) => s.publicationId === p.id)
      .map((s) => ({ id: s.id, priority: s.priority, ownerAddresses: s.email ? [`mailto:${s.email}`] : [] }));
    const spec: PublicationSpec = {
      id: p.id,
      kind: p.kind,
      privacy: p.privacy,
      filters: p.filters,
      keepAlarms: p.keepAlarms,
      audience: 'owner',
      ownerAddresses: [...new Set(own.flatMap((s) => s.ownerAddresses))],
      uidSecret,
    };
    return { ...p, spec, sources: own, sourceIds: own.map((s) => s.id) };
  });
  return { feed: row.feed, ownerEmail: row.email, publications };
}

export type IndexEntry = { uid: string; href: string; seq: bigint; etag: string };
export type PubIndex = { byHref: Map<string, IndexEntry>; byUid: Map<string, IndexEntry>; maxSeq: bigint };

const INDEX_CACHE_SIZE = 64;
const indexCache = new Map<string, PubIndex>();

/**
 * Every live UID of `pub` with its href and ETag, computed from `uid, max(seq)` without loading
 * or rendering a resource. `max(seq)` counts tombstoned copies too, so deleting one copy in a
 * virtual publication changes the merged object's ETag. Cached per `(pubId, epoch, maxSeq)` in a
 * small LRU: any change to the publication's sources moves `maxSeq` and misses the cache.
 */
export async function pubIndex(tx: TenantTx, pub: Pub): Promise<PubIndex> {
  if (pub.sourceIds.length === 0) return { byHref: new Map(), byUid: new Map(), maxSeq: 0n };
  const { maxSeq } = await publicationState(tx, pub.sourceIds);
  const cacheKey = `${pub.id}/${pub.epoch}/${maxSeq}`;
  const cached = indexCache.get(cacheKey);
  if (cached) {
    indexCache.delete(cacheKey);
    indexCache.set(cacheKey, cached);
    return cached;
  }
  const rows = await tx
    .select({ uid: resource.uid, seq: max(resource.seq).mapWith(BigInt) })
    .from(resource)
    .where(inArray(resource.sourceCalendarId, pub.sourceIds))
    .groupBy(resource.uid)
    .orderBy(resource.uid)
    .having(sql`bool_or(not ${resource.deleted})`);
  const entries = await Promise.all(
    rows.map(async ({ uid, seq }): Promise<IndexEntry> => ({ uid, seq, href: await hrefFor(pub.spec, uid), etag: await objectEtag(pub.spec, pub.epoch, uid, seq) })),
  );
  const index = { byHref: new Map(entries.map((e) => [e.href, e])), byUid: new Map(entries.map((e) => [e.uid, e])), maxSeq };
  indexCache.set(cacheKey, index);
  if (indexCache.size > INDEX_CACHE_SIZE) indexCache.delete(indexCache.keys().next().value ?? '');
  return index;
}

export type Rendered = { href: string; ics: string };

/** Projects `rows` (live copies from `pub`'s sources); rows of other calendars are ignored. Sinks mirror exactly this. */
export function projectRows(pub: Pub, rows: LiveResource[]): Promise<ProjectedObject[]> {
  const sources = new Map(pub.sources.map((s) => [s.id, s]));
  const inputs = rows.flatMap((r): SourceResource[] => {
    const source = sources.get(r.sourceCalendarId);
    return source ? [{ sourceCalendarId: source.id, priority: source.priority, ownerAddresses: source.ownerAddresses, resource: r.data }] : [];
  });
  return project(pub.spec, inputs);
}

/** Projects `rows` (live copies from `pub`'s sources) and serialises each object as its own VCALENDAR, by source UID. */
export async function render(pub: Pub, rows: LiveResource[]): Promise<Map<string, Rendered>> {
  const objects = await projectRows(pub, rows);
  return new Map(
    objects.map((o) => [o.sourceUid, { href: o.href, ics: serializeCalendar({ props: [], resources: [addMissingTimezones(o.resource)] }) }]),
  );
}

/** Renders the live objects of `uids`. UIDs the projection hides (filters, busy-only free time) are absent. */
export async function renderUids(tx: TenantTx, pub: Pub, uids: string[]): Promise<Map<string, Rendered>> {
  return uids.length ? render(pub, await resourcesByUids(tx, pub.sourceIds, uids)) : new Map();
}
