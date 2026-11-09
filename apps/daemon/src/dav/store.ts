/**
 * CalDAV collection implementations: hosted payloads and metadata, and enabled feed projection
 * specs with the per-publication object index (href → UID, ETag) built without rendering, and
 * rendered objects. Everything except `loginByUsername` takes the request's `TenantTx`.
 */
import { addMissingTimezones, hrefFor, objectEtag, project, serializeCalendar, type ProjectedObject, type PublicationSpec, type SourceResource } from '@supercal/core';
import {
  calendarAccount,
  davLogin,
  changesSince,
  resourcesIn,
  tombstoneFloor,
  sourceObject,
  type SourceCalendar,
  type ResourceRow,
  type DavLoginId,
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
import { deviceHomeCalendars, atLeast } from '../hosted/access.ts';
import { memberSpec } from '../hosted/read.ts';
import type { Principal } from '../auth/principal.ts';
import type { DavLogin } from './auth.ts';
import { createLogger } from '../log.ts';

const log = createLogger({ component: 'dav' });

/** Look up device logins before feeds, using only control-role credential columns. */
export async function loginByUsername(username: string): Promise<DavLogin | null> {
  return withControl(async (tx) => {
    const [device] = await tx.select({ id: davLogin.id, tenantId: davLogin.tenantId, userId: davLogin.userId, passwordHash: davLogin.passwordHash })
      .from(davLogin).where(eq(davLogin.username, username));
    if (device) return { kind: 'user', ...device };
    const [row] = await tx.select({ id: feed.id, tenantId: feed.tenantId, passwordHash: feed.caldavPasswordHash })
      .from(feed).where(eq(feed.caldavUsername, username));
    return row?.passwordHash ? { kind: 'feed', ...row, passwordHash: row.passwordHash } : null;
  });
}

type Source = { id: SourceCalendarId; priority: number; ownerAddresses: string[] };

/** An enabled publication with what projecting it needs. */
export type Pub = Pick<Publication, 'name' | 'color' | 'sortOrder' | 'slug' | 'epoch'> & { id: string; spec: PublicationSpec; sources: Source[]; sourceIds: SourceCalendarId[] };

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
  const rendered = new Map<string, Rendered>();
  for (const object of objects) {
    try {
      rendered.set(object.sourceUid, { href: object.href, ics: serializeCalendar({ props: [], resources: [addMissingTimezones(object.resource)] }) });
    } catch (error) {
      log.warn('could not render object', { sourceUid: object.sourceUid, error });
    }
  }
  return rendered;
}

/** Renders the live objects of `uids`. UIDs the projection hides (filters, busy-only free time) are absent. */
export async function renderUids(tx: TenantTx, pub: Pub, uids: string[]): Promise<Map<string, Rendered>> {
  return uids.length ? render(pub, await resourcesByUids(tx, pub.sourceIds, uids)) : new Map();
}

const TOKEN = /^https?:\/\/[^/]+\/ns\/sync\/([^/]+)\/(\d+)\/(\d+)$/;
type Change = { uid: string; alive: boolean; href: string; etag: string };
type ChangePage = { rows: Change[]; maxSeq: bigint; hasMore: boolean };

/** One calendar collection as the handlers see it; changes encapsulates source-specific tombstones. */
export type CollectionView = {
  segment: string;
  display: { name: string; color: string | null; sortOrder: number; description?: string | null; timezone?: string | null };
  privileges: 'read' | 'write' | 'manage';
  calendar?: SourceCalendar;
  shared?: boolean;
  index(tx: TenantTx): Promise<PubIndex>;
  objects(tx: TenantTx, uids: string[]): Promise<Map<string, { ics: string }>>;
  query(tx: TenantTx, range?: { from: Date; to: Date }): Promise<Map<string, { ics: string }>>;
  token(seq: bigint): string;
  parseToken(tx: TenantTx, token: string): Promise<bigint | null>;
  changeEntry(row: ResourceRow, maxSeqOfUid: bigint): Promise<{ href: string; etag: string }>;
  changes(tx: TenantTx, since: bigint, limit: number): Promise<ChangePage>;
};

function tokenFunctions(host: string, id: string, epoch: number) {
  return {
    token: (seq: bigint) => `https://${host}/ns/sync/${id}/${epoch}/${seq}`,
    async parseToken(tx: TenantTx, token: string) {
      const m = TOKEN.exec(token);
      const seq = m ? BigInt(m[3] ?? 0) : null;
      return m?.[1] === id && Number(m[2]) === epoch && seq !== null && seq >= await tombstoneFloor(tx) ? seq : null;
    },
  };
}

/** Published feeds retain their computed hrefs, projection, ETags and virtual UID merge semantics. */
export function publicationCollection(pub: Pub, host: string): CollectionView {
  const changeEntry = async (row: ResourceRow, seq: bigint) => ({ href: await hrefFor(pub.spec, row.uid), etag: await objectEtag(pub.spec, pub.epoch, row.uid, seq) });
  return {
    segment: pub.slug, display: pub, privileges: 'read',
    index: (tx) => pubIndex(tx, pub),
    objects: (tx, uids) => renderUids(tx, pub, uids),
    query: async (tx, range) => render(pub, await resourcesIn(tx, pub.sourceIds, range)),
    ...tokenFunctions(host, pub.id, pub.epoch),
    changeEntry,
    async changes(tx, since, limit) {
      const page = await changesSince(tx, pub.sourceIds, since, limit);
      const changed = new Map<string, { row: ResourceRow; alive: boolean; seq: bigint }>();
      for (const row of page.rows) {
        const seen = changed.get(row.uid);
        changed.set(row.uid, { row, alive: (seen?.alive ?? false) || !row.deleted, seq: seen && seen.seq > row.seq ? seen.seq : row.seq });
      }
      const tombstoned = [...changed].filter(([, v]) => !v.alive).map(([uid]) => uid);
      const stillHeld = new Set(tombstoned.length ? (await resourcesByUids(tx, pub.sourceIds, tombstoned)).map((row) => row.uid) : []);
      const rows = await Promise.all([...changed].map(async ([uid, v]) => ({ uid, alive: v.alive || stillHeld.has(uid), ...await changeEntry(v.row, v.seq) })));
      return { ...page, rows };
    },
  };
}

/** Hosted reads preserve the stored bytes and names, including names retained on tombstones. */
export function hostedCollection(calendar: SourceCalendar, privileges: CollectionView['privileges'], host: string): CollectionView {
  const sourceIds = [calendar.id];
  async function objects(tx: TenantTx, uids: string[]): Promise<Map<string, { ics: string }>> {
    if (!uids.length) return new Map();
    const rows = await tx.select({ uid: sourceObject.groupUid, payload: sourceObject.payload }).from(sourceObject)
      .where(and(eq(sourceObject.sourceCalendarId, calendar.id), inArray(sourceObject.groupUid, uids)));
    return new Map(rows.map((r) => {
      if (typeof r.payload !== 'string') throw new Error('Hosted payload must be iCalendar text');
      return [r.uid, { ics: r.payload }];
    }));
  }
  const changeEntry = async (row: ResourceRow) => ({ href: encodeURIComponent(row.objectName ?? ''), etag: `"${row.revision}"` });
  return {
    segment: calendar.providerCalendarId, display: calendar, privileges, calendar,
    async index(tx) {
      const { maxSeq } = await publicationState(tx, sourceIds);
      // Only metadata: a Depth 1 PROPFIND must never fetch the 5,000 payloads.
      const rows = await tx.select({ name: sourceObject.providerObjectId, uid: sourceObject.groupUid, etag: sourceObject.etag })
        .from(sourceObject).where(eq(sourceObject.sourceCalendarId, calendar.id));
      const entries = rows.map((r) => ({ uid: r.uid, href: encodeURIComponent(r.name), etag: `"${r.etag}"`, seq: 0n }));
      return { byHref: new Map(entries.map((e) => [decodeURIComponent(e.href), e])), byUid: new Map(entries.map((e) => [e.uid, e])), maxSeq };
    },
    objects,
    query: async (tx, range) => objects(tx, (await resourcesIn(tx, sourceIds, range)).map((r) => r.uid)),
    ...tokenFunctions(host, calendar.id, calendar.syncEpoch),
    changeEntry,
    async changes(tx, since, limit) {
      const page = await changesSince(tx, sourceIds, since, limit);
      return { ...page, rows: await Promise.all(page.rows.map(async (row) => ({ uid: row.uid, alive: !row.deleted, ...await changeEntry(row) }))) };
    },
  };
}

export type UserAccount = { login: typeof davLogin.$inferSelect; ownerEmail: string | null; collections: CollectionView[] };
/** Reload the credential and active owned/shared collections inside the authenticated tenant transaction. */
export async function loadUserAccount(tx: TenantTx, id: DavLoginId, host: string, principal: Principal): Promise<UserAccount | null> {
  const [row] = await tx.select({ login: davLogin, email: user.email }).from(davLogin)
    .innerJoin(user, eq(user.id, davLogin.userId)).where(eq(davLogin.id, id));
  if (!row) return null;
  const calendars = (await deviceHomeCalendars(tx, principal)).filter(({ calendar }) => calendar.state === 'active');
  const accounts = calendars.length ? await tx.select({ id: calendarAccount.id, ownerId: user.id, ownerName: user.name, email: calendarAccount.email, provider: calendarAccount.provider })
    .from(calendarAccount).innerJoin(user, eq(user.id, calendarAccount.ownerUserId))
    .where(inArray(calendarAccount.id, calendars.map(({ calendar }) => calendar.accountId))) : [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const collections = calendars.flatMap(({ calendar, access }): CollectionView[] => {
    const account = byId.get(calendar.accountId)!;
    const own = account.ownerId === principal.userId;
    // Own imported calendars continue to be served through feeds.
    if (own && account.provider !== 'hosted') return [];
    const name = own ? calendar.name : `${calendar.name} (${account.ownerName})`;
    if (account.provider === 'hosted' && access !== 'read') {
      const view = hostedCollection(calendar, atLeast(access, 'manage') ? 'manage' : 'write', host);
      return [{ ...view, segment: own ? calendar.providerCalendarId : calendar.id, display: { ...view.display, name }, shared: !own }];
    }
    const ownerAddresses = account.email ? [`mailto:${account.email}`] : [];
    const spec = { ...memberSpec(calendar.id, ownerAddresses), audience: access === 'read' ? 'member' as const : 'owner' as const };
    const pub: Pub = { id: `${calendar.id}.r`, slug: calendar.id, name, color: calendar.color, sortOrder: calendar.sortOrder, epoch: calendar.syncEpoch,
      spec, sources: [{ id: calendar.id, priority: 0, ownerAddresses }], sourceIds: [calendar.id] };
    return [{ ...publicationCollection(pub, host), calendar, shared: !own }];
  });
  // A user's provider_calendar_id wins over a colliding shared calendar id.
  collections.sort((a, b) => Number(a.shared ?? false) - Number(b.shared ?? false) || a.display.sortOrder - b.display.sortOrder);

  await tx.update(davLogin).set({ lastUsedAt: sql`now()` }).where(and(eq(davLogin.id, id), sql`(${davLogin.lastUsedAt} is null or ${davLogin.lastUsedAt} < now() - interval '1 hour')`));
  return { ...row, ownerEmail: row.email, collections };
}
