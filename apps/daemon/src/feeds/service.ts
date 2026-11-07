/**
 * Feeds and publications (architecture §3, §6): the domain service behind the management API, and
 * the hooks the sync engine calls when it discovers or loses a source calendar.
 *
 *   const feeds = createFeedService(secrets);
 *   await withTenant(tenantId, (tx) => feeds.ensurePassthroughPublication(tx, calendar, account));
 *
 * Functions that take a `Principal` enforce `canManageOwned` on the feed's owner (404 when the id
 * is not visible in the tenant at all). Every mutation bumps `epoch` or `config_version` as
 * `publicationChangeKind` decides, and writes the audit log, in the caller's transaction.
 */
import { Temporal } from '@js-temporal/polyfill';
import { expandOccurrences, project, summary, textValue, UnknownTimeZoneError, type SourceResource } from '@supercal/core';
import {
  bumpConfigVersion,
  bumpEpoch,
  calendarAccount,
  feed,
  member,
  newId,
  publication,
  publicationChangeKind,
  publicationSource,
  resourcesIn,
  sink,
  sourceCalendar,
  user,
  type CalendarAccount,
  type Feed,
  type FeedId,
  type Privacy,
  type PublicationConfig,
  type PublicationFilters,
  type PublicationId,
  type Publication as PublicationRow,
  type SecretBox,
  type SourceCalendar,
  type SourceCalendarId,
  type TenantId,
  type TenantTx,
} from '@supercal/db';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { audit } from '../api/kit/audit.ts';
import { BadRequest, Conflict, Forbidden, NotFound } from '../api/kit/problem.ts';
import { canManageOwned } from '../auth/policy.ts';
import type { Principal } from '../auth/principal.ts';
import { notifyFeedCredentialsRotated } from '../bus.ts';
import { caldavUsername, newCaldavPassword, newIcsToken, newUidSecret, openUidSecret, ownerHandle } from './credentials.ts';

export type FeedService = ReturnType<typeof createFeedService>;

/** A publication with its sources, highest priority (lowest number) first. */
export type Publication = PublicationRow & { sources: { calendarId: SourceCalendarId; priority: number }[] };

export type SourceInput = { calendarId: SourceCalendarId; priority?: number | undefined };

type Settings = { name: string; color: string | null; privacy: Privacy; filters: PublicationFilters; keepAlarms: boolean; enabled: boolean };

export type NewPublication = { [K in keyof Settings]?: Settings[K] | undefined } & (
  | { kind: 'passthrough'; sourceCalendarId: SourceCalendarId }
  | { kind: 'virtual'; name: string; sources: SourceInput[] }
);

export type PublicationPatch = { [K in Exclude<keyof Settings, 'filters'>]?: Settings[K] | undefined } & {
  filters?: { [K in keyof PublicationFilters]?: boolean | undefined } | undefined;
  sources?: SourceInput[] | undefined;
};

/** Secrets of a newly created feed; returned once and never stored in the clear. */
export type FeedSecrets = { caldav: { username: string; password: string }; ics: { token: string } };

export type OccurrenceItem = {
  publicationId: PublicationId;
  outputUid: string;
  recurrenceId: string;
  start: string;
  end: string;
  allDay: boolean;
  summary: string;
  location?: string;
  color: string | null;
};

const DEFAULT_FEED_NAME = 'My calendars';
const NEEDS_TWO = 'needs at least two calendars';
const SOURCE_GONE = 'source calendar is gone';
const DEFAULT_FILTERS: PublicationFilters = { hideDeclined: false, hideCancelled: false, hideAllDay: false };
/** The preview's cap on returned occurrences; beyond it the response is `truncated`. */
const MAX_OCCURRENCES = 2000;

const currentTenant = async (tx: TenantTx) => {
  const [row] = await tx.execute<{ tenant: string }>(sql`select current_setting('app.tenant_id') as tenant`);
  if (!row) throw new Error('no tenant bound to the transaction');
  return row.tenant as TenantId;
};

/** `name` as a slug (`[a-z0-9-]`), made unique among `taken` with a numeric suffix. */
function slugFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 48)
      .replace(/^-+|-+$/g, '') || 'calendar';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** What `publicationChangeKind` compares. */
const configOf = ({ id: _, tenantId: _t, epoch: _e, configVersion: _c, status: _s, statusDetail: _d, updatedAt: _u, sources, ...row }: Publication): PublicationConfig => ({
  ...row,
  sources: sources.map(({ calendarId, priority }) => ({ sourceCalendarId: calendarId, priority })),
});

/** A provider colour as `#rrggbb` (dropping any alpha), or null when it is not a hex colour. */
const normalizeColor = (color: string | null) => (color && /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7).toLowerCase() : null);

/** Sources with their default priority (their position) filled in. */
const withPriorities = (sources: SourceInput[]) => sources.map(({ calendarId, priority }, index) => ({ calendarId, priority: priority ?? index }));

/** Emits `feed.changed` to SSE subscribers once #11's `notifyEvent` exists. */
async function feedChanged(_tx: TenantTx, _feedId: FeedId): Promise<void> {
  // TODO(#11): await notifyEvent(tx, tenantId, { type: 'feed.changed', feedId });
}

async function publicationsWhere(tx: TenantTx, where: SQL): Promise<Publication[]> {
  const rows = await tx.select().from(publication).where(where).orderBy(asc(publication.sortOrder), asc(publication.id));
  if (rows.length === 0) return [];
  const links = await tx
    .select()
    .from(publicationSource)
    .where(
      inArray(
        publicationSource.publicationId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(publicationSource.priority), asc(publicationSource.sourceCalendarId));
  return rows.map((row) => ({
    ...row,
    sources: links.filter((link) => link.publicationId === row.id).map((link) => ({ calendarId: link.sourceCalendarId, priority: link.priority })),
  }));
}

const publicationsOf = (tx: TenantTx, feedId: FeedId) => publicationsWhere(tx, eq(publication.feedId, feedId));

/** The feed, if visible in the tenant and manageable by `principal`. */
async function loadFeed(tx: TenantTx, principal: Principal, id: FeedId): Promise<Feed> {
  const [row] = await tx.select().from(feed).where(eq(feed.id, id));
  if (!row) throw new NotFound('No such feed');
  if (!canManageOwned(principal, row.ownerUserId)) throw new Forbidden('You can only manage your own feeds');
  return row;
}

async function loadPublication(tx: TenantTx, principal: Principal, id: PublicationId): Promise<{ feed: Feed; publication: Publication }> {
  const [found] = await publicationsWhere(tx, eq(publication.id, id));
  if (!found) throw new NotFound('No such publication');
  return { feed: await loadFeed(tx, principal, found.feedId), publication: found };
}

/**
 * Throws a 400/409 problem unless `sources` may feed a `kind` publication in `owner`'s feed: the
 * calendars are distinct, the owner's, still present and not sink targets; a virtual one has at
 * least two; a passthrough source is not already passthrough-published in the feed (`self` aside).
 */
async function validateSources(
  tx: TenantTx,
  target: { feed: Feed; kind: PublicationRow['kind']; self?: PublicationId },
  sources: { calendarId: SourceCalendarId }[],
): Promise<void> {
  const ids = sources.map((s) => s.calendarId);
  if (new Set(ids).size !== ids.length) throw new BadRequest([{ path: 'sources', message: 'listed twice' }], 'Each calendar can appear only once');
  if (target.kind === 'virtual' && ids.length < 2)
    throw new BadRequest([{ path: 'sources', message: NEEDS_TWO }], `A virtual publication ${NEEDS_TWO}`);

  const calendars = await tx
    .select({ id: sourceCalendar.id, state: sourceCalendar.state, providerCalendarId: sourceCalendar.providerCalendarId })
    .from(sourceCalendar)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
    .where(and(inArray(sourceCalendar.id, ids), eq(calendarAccount.ownerUserId, target.feed.ownerUserId)));
  const missing = ids.find((id) => !calendars.some((c) => c.id === id));
  if (missing) throw new BadRequest([{ path: 'sources', message: 'unknown calendar' }], `Calendar ${missing} is not one of the feed owner’s calendars`);
  const gone = calendars.find((c) => c.state === 'gone');
  if (gone) throw new BadRequest([{ path: 'sources', message: 'calendar is gone' }], `Calendar ${gone.id} no longer exists at its provider`);

  const sinks = await tx
    .select({ providerCalendarId: sink.providerCalendarId })
    .from(sink)
    .where(
      inArray(
        sink.providerCalendarId,
        calendars.map((c) => c.providerCalendarId),
      ),
    );
  const sinkTarget = calendars.find((c) => sinks.some((s) => s.providerCalendarId === c.providerCalendarId));
  if (sinkTarget)
    throw new BadRequest([{ path: 'sources', message: 'sink target' }], `Calendar ${sinkTarget.id} is written by a sink and cannot be a source`);

  if (target.kind === 'passthrough') {
    const taken = (await publicationsOf(tx, target.feed.id)).find(
      (p) => p.kind === 'passthrough' && p.id !== target.self && p.sources.some((s) => s.calendarId === ids[0]),
    );
    if (taken) throw new Conflict(`Calendar ${ids[0]} is already published in this feed as ${taken.id}`);
  }
}

type InsertPublication = Settings & { kind: PublicationRow['kind']; sources: { calendarId: SourceCalendarId; priority: number }[] };

/** Inserts a publication at the end of the feed with a fresh slug, and bumps its epoch to 1. */
async function insertPublication(tx: TenantTx, target: Feed, values: InsertPublication): Promise<Publication> {
  const siblings = await tx.select({ slug: publication.slug, sortOrder: publication.sortOrder }).from(publication).where(eq(publication.feedId, target.id));
  const sortOrder = Math.max(-1, ...siblings.map((s) => s.sortOrder)) + 1;
  const { sources, ...settings } = values;
  const [row] = await tx
    .insert(publication)
    .values({ ...settings, tenantId: target.tenantId, feedId: target.id, slug: slugFor(values.name, new Set(siblings.map((s) => s.slug))), sortOrder })
    .returning();
  if (!row) throw new Error('publication insert returned no row');
  await tx.insert(publicationSource).values(sources.map((s) => ({ tenantId: target.tenantId, publicationId: row.id, sourceCalendarId: s.calendarId, priority: s.priority })));
  const epoch = await bumpEpoch(tx, row.id);
  await feedChanged(tx, target.id);
  return { ...row, epoch, sources };
}

/** Builds the feed service. `secrets` encrypts and opens each feed's `uid_secret`. */
export function createFeedService(secrets: SecretBox) {
  /** Inserts a feed for `ownerUserId` with fresh credentials; for a default feed, null if one already exists. */
  async function insertFeed(tx: TenantTx, ownerUserId: string, name: string, isDefault: boolean): Promise<{ feed: Feed; secrets: FeedSecrets } | null> {
    const [owner] = await tx.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, ownerUserId));
    if (!owner) throw new NotFound('No such user in this tenant');
    const tenantId = await currentTenant(tx);
    const id = newId('feed');
    const caldav = await newCaldavPassword();
    const ics = newIcsToken();
    const username = caldavUsername(ownerHandle(owner));
    const [row] = await tx
      .insert(feed)
      .values({
        id,
        tenantId,
        ownerUserId,
        name,
        isDefault,
        caldavUsername: username,
        caldavPasswordHash: caldav.hash,
        icsTokenHash: ics.hash,
        uidSecret: await newUidSecret(secrets, { tenantId, id }),
      })
      .onConflictDoNothing({ target: [feed.tenantId, feed.ownerUserId], where: sql`is_default` })
      .returning();
    if (!row) return null;
    await feedChanged(tx, id);
    return { feed: row, secrets: { caldav: { username, password: caldav.password }, ics: { token: ics.token } } };
  }

  /** The user's default feed ("My calendars"), created with fresh credentials on first access. */
  async function getOrCreateDefaultFeed(tx: TenantTx, userId: string): Promise<Feed> {
    const existing = () => tx.select().from(feed).where(and(eq(feed.ownerUserId, userId), eq(feed.isDefault, true)));
    const [found] = await existing();
    if (found) return found;
    const created = await insertFeed(tx, userId, DEFAULT_FEED_NAME, true);
    if (created) return created.feed;
    // A concurrent transaction created it first.
    const [raced] = await existing();
    if (!raced) throw new Error('default feed vanished');
    return raced;
  }

  /**
   * Called by the sync engine when discovery finds a new source calendar: publishes it in its
   * owner's default feed (enabled when the account auto-publishes), unless it already is.
   */
  async function ensurePassthroughPublication(tx: TenantTx, calendar: SourceCalendar, account: CalendarAccount): Promise<Publication> {
    const target = await getOrCreateDefaultFeed(tx, account.ownerUserId);
    const existing = (await publicationsOf(tx, target.id)).find((p) => p.kind === 'passthrough' && p.sources.some((s) => s.calendarId === calendar.id));
    if (existing) return existing;
    return insertPublication(tx, target, {
      kind: 'passthrough',
      name: calendar.name,
      color: normalizeColor(calendar.color),
      enabled: account.autoPublish,
      privacy: 'full',
      filters: DEFAULT_FILTERS,
      keepAlarms: false,
      sources: [{ calendarId: calendar.id, priority: 0 }],
    });
  }

  /**
   * Called by the sync engine when a source calendar disappears: its passthrough publications are
   * disabled, and it leaves every virtual publication; one left with fewer than two sources is
   * disabled as `disabled-invalid`. Each affected publication's epoch is bumped.
   */
  async function onCalendarGone(tx: TenantTx, calendarId: SourceCalendarId): Promise<void> {
    const links = await tx.select({ publicationId: publicationSource.publicationId }).from(publicationSource).where(eq(publicationSource.sourceCalendarId, calendarId));
    if (links.length === 0) return;
    const affected = await publicationsWhere(
      tx,
      inArray(
        publication.id,
        links.map((l) => l.publicationId),
      ),
    );
    const invalid = (statusDetail: string) => ({ enabled: false, status: 'disabled-invalid' as const, statusDetail, updatedAt: new Date() });
    for (const p of affected) {
      if (p.kind === 'passthrough') {
        await tx.update(publication).set(invalid(SOURCE_GONE)).where(eq(publication.id, p.id));
        if (p.enabled) await bumpEpoch(tx, p.id);
      } else {
        await tx.delete(publicationSource).where(and(eq(publicationSource.publicationId, p.id), eq(publicationSource.sourceCalendarId, calendarId)));
        if (p.sources.length - 1 < 2) await tx.update(publication).set(invalid(NEEDS_TWO)).where(eq(publication.id, p.id));
        await bumpEpoch(tx, p.id);
      }
      await feedChanged(tx, p.feedId);
    }
  }

  /** The feeds of `ownerUserId` (default: the principal), creating their default feed on first access. */
  async function listFeeds(tx: TenantTx, principal: Principal, ownerUserId = principal.userId): Promise<Feed[]> {
    if (!canManageOwned(principal, ownerUserId)) throw new Forbidden('You can only list your own feeds');
    const [membership] = await tx.select({ userId: member.userId }).from(member).where(eq(member.userId, ownerUserId));
    if (!membership) throw new NotFound('No such user in this tenant');
    await getOrCreateDefaultFeed(tx, ownerUserId);
    return tx.select().from(feed).where(eq(feed.ownerUserId, ownerUserId)).orderBy(asc(feed.id));
  }

  /** Creates an extra feed for the principal; its credentials are returned only here. */
  async function createFeed(tx: TenantTx, principal: Principal, name: string): Promise<{ feed: Feed; secrets: FeedSecrets }> {
    const created = await insertFeed(tx, principal.userId, name, false);
    if (!created) throw new Error('non-default feed insert conflicted');
    await audit(tx, principal, 'feed.create', { type: 'feed', id: created.feed.id }, { name });
    return created;
  }

  /** Renames a feed. `check` runs against the current row first (the route's If-Match). */
  async function updateFeed(tx: TenantTx, principal: Principal, id: FeedId, changes: { name: string }, check: (current: Feed) => void = () => {}) {
    check(await loadFeed(tx, principal, id));
    const [row] = await tx.update(feed).set({ name: changes.name, updatedAt: new Date() }).where(eq(feed.id, id)).returning();
    if (!row) throw new NotFound('No such feed');
    await audit(tx, principal, 'feed.update', { type: 'feed', id }, changes);
    await feedChanged(tx, id);
    return row;
  }

  /** Deletes an extra feed and its publications; the default feed cannot be deleted (409). */
  async function deleteFeed(tx: TenantTx, principal: Principal, id: FeedId): Promise<void> {
    const found = await loadFeed(tx, principal, id);
    if (found.isDefault) throw new Conflict('The default feed cannot be deleted');
    await tx.delete(feed).where(eq(feed.id, id));
    await audit(tx, principal, 'feed.delete', { type: 'feed', id }, { name: found.name });
    await feedChanged(tx, id);
  }

  /** Stores new credential hashes, so the old secret stops working, and tells every process to drop cached verifications. */
  async function rotated(tx: TenantTx, principal: Principal, id: FeedId, kind: 'caldav' | 'ics', set: Partial<Feed>) {
    await tx.update(feed).set({ ...set, updatedAt: new Date() }).where(eq(feed.id, id));
    await notifyFeedCredentialsRotated(tx, id);
    await audit(tx, principal, 'feed.credentials.rotate', { type: 'feed', id }, { kind });
  }

  /** Issues a new CalDAV app password; the username stays. */
  async function rotateCaldavPassword(tx: TenantTx, principal: Principal, id: FeedId): Promise<{ username: string; password: string }> {
    const found = await loadFeed(tx, principal, id);
    const { password, hash } = await newCaldavPassword();
    await rotated(tx, principal, id, 'caldav', { caldavPasswordHash: hash });
    return { username: found.caldavUsername, password };
  }

  /** Issues a new ICS token. Returns it with the feed's publications, to build their URLs. */
  async function rotateIcsToken(tx: TenantTx, principal: Principal, id: FeedId): Promise<{ token: string; publications: Publication[] }> {
    await loadFeed(tx, principal, id);
    const { token, hash } = newIcsToken();
    await rotated(tx, principal, id, 'ics', { icsTokenHash: hash });
    return { token, publications: await publicationsOf(tx, id) };
  }

  async function listPublications(tx: TenantTx, principal: Principal, feedId: FeedId): Promise<Publication[]> {
    await loadFeed(tx, principal, feedId);
    return publicationsOf(tx, feedId);
  }

  async function getPublication(tx: TenantTx, principal: Principal, id: PublicationId): Promise<Publication> {
    return (await loadPublication(tx, principal, id)).publication;
  }

  /** Adds a publication to the end of the feed. A passthrough one defaults to its calendar's name and colour. */
  async function createPublication(tx: TenantTx, principal: Principal, feedId: FeedId, input: NewPublication): Promise<Publication> {
    const target = await loadFeed(tx, principal, feedId);
    const sources = withPriorities(input.kind === 'virtual' ? input.sources : [{ calendarId: input.sourceCalendarId }]);
    await validateSources(tx, { feed: target, kind: input.kind }, sources);
    const [calendar] =
      input.kind === 'passthrough'
        ? await tx.select({ name: sourceCalendar.name, color: sourceCalendar.color }).from(sourceCalendar).where(eq(sourceCalendar.id, input.sourceCalendarId))
        : [];
    const created = await insertPublication(tx, target, {
      kind: input.kind,
      name: input.name ?? calendar?.name ?? 'Calendar',
      color: input.color === undefined ? normalizeColor(calendar?.color ?? null) : input.color,
      privacy: input.privacy ?? 'full',
      filters: input.filters ?? DEFAULT_FILTERS,
      keepAlarms: input.keepAlarms ?? false,
      enabled: input.enabled ?? true,
      sources,
    });
    await audit(tx, principal, 'publication.create', { type: 'publication', id: created.id }, { feedId, ...input });
    return created;
  }

  /**
   * Applies `patch`, bumping epoch or config version as the change needs. New sources, or enabling
   * a disabled publication, are validated first; a valid result clears `disabled-invalid`.
   */
  async function updatePublication(
    tx: TenantTx,
    principal: Principal,
    id: PublicationId,
    patch: PublicationPatch,
    check: (current: Publication) => void = () => {},
  ): Promise<Publication> {
    const { feed: owner, publication: before } = await loadPublication(tx, principal, id);
    check(before);
    if (patch.sources && before.kind === 'passthrough')
      throw new BadRequest([{ path: 'sources', message: 'passthrough' }], 'A passthrough publication’s calendar cannot change');

    const sources = patch.sources ? withPriorities(patch.sources) : before.sources;
    const enabled = patch.enabled ?? before.enabled;
    const revalidate = patch.sources !== undefined || (enabled && !before.enabled);
    if (revalidate) await validateSources(tx, { feed: owner, kind: before.kind, self: id }, sources);

    const after: Publication = {
      ...before,
      name: patch.name ?? before.name,
      color: patch.color === undefined ? before.color : patch.color,
      privacy: patch.privacy ?? before.privacy,
      keepAlarms: patch.keepAlarms ?? before.keepAlarms,
      enabled,
      filters: {
        hideDeclined: patch.filters?.hideDeclined ?? before.filters.hideDeclined,
        hideCancelled: patch.filters?.hideCancelled ?? before.filters.hideCancelled,
        hideAllDay: patch.filters?.hideAllDay ?? before.filters.hideAllDay,
      },
      sources,
      ...(revalidate && { status: 'ok' as const, statusDetail: null }),
    };
    const kind = publicationChangeKind(configOf(before), configOf(after));
    const statusChanged = after.status !== before.status;
    if (kind === 'none' && !statusChanged) return before;

    const { id: _id, tenantId: _t, feedId: _f, kind: _k, epoch: _e, configVersion: _c, sources: _s, ...columns } = after;
    await tx.update(publication).set({ ...columns, updatedAt: new Date() }).where(eq(publication.id, id));
    if (patch.sources) {
      await tx.delete(publicationSource).where(eq(publicationSource.publicationId, id));
      await tx.insert(publicationSource).values(sources.map((s) => ({ tenantId: before.tenantId, publicationId: id, sourceCalendarId: s.calendarId, priority: s.priority })));
    }
    if (kind === 'epoch') await bumpEpoch(tx, id);
    if (kind === 'config') await bumpConfigVersion(tx, id);
    await audit(tx, principal, 'publication.update', { type: 'publication', id }, { ...patch, change: kind });
    await feedChanged(tx, before.feedId);
    return (await loadPublication(tx, principal, id)).publication;
  }

  async function deletePublication(tx: TenantTx, principal: Principal, id: PublicationId): Promise<void> {
    const { publication: found } = await loadPublication(tx, principal, id);
    await tx.delete(publication).where(eq(publication.id, id));
    await audit(tx, principal, 'publication.delete', { type: 'publication', id }, { feedId: found.feedId, name: found.name });
    await feedChanged(tx, found.feedId);
  }

  /** Sets the feed's publication order; `ids` must list every publication of the feed exactly once. */
  async function reorderPublications(tx: TenantTx, principal: Principal, feedId: FeedId, ids: PublicationId[]): Promise<Publication[]> {
    await loadFeed(tx, principal, feedId);
    const current = await publicationsOf(tx, feedId);
    const known = new Set(current.map((p) => p.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
      throw new BadRequest([{ path: 'ids', message: 'must list every publication of the feed once' }], 'The order must list every publication of the feed exactly once');
    for (const [sortOrder, id] of ids.entries()) {
      if (current.find((p) => p.id === id)?.sortOrder === sortOrder) continue;
      await tx.update(publication).set({ sortOrder, updatedAt: new Date() }).where(eq(publication.id, id));
      await bumpConfigVersion(tx, id);
    }
    await audit(tx, principal, 'publication.reorder', { type: 'feed', id: feedId }, { ids });
    await feedChanged(tx, feedId);
    return publicationsOf(tx, feedId);
  }

  /**
   * Exactly what the feed publishes in `[from, to)`, expanded: each enabled publication (or only
   * `publicationId`) projected and expanded in its source calendar's time zone, sorted by start.
   */
  async function previewOccurrences(
    tx: TenantTx,
    principal: Principal,
    feedId: FeedId,
    range: { from: Date; to: Date; publicationId?: PublicationId | undefined },
  ): Promise<{ items: OccurrenceItem[]; truncated: boolean }> {
    const target = await loadFeed(tx, principal, feedId);
    const all = await publicationsOf(tx, feedId);
    const chosen = range.publicationId ? all.filter((p) => p.id === range.publicationId) : all.filter((p) => p.enabled);
    if (range.publicationId && chosen.length === 0) throw new NotFound('No such publication in this feed');

    const calendarIds = [...new Set(chosen.flatMap((p) => p.sources.map((s) => s.calendarId)))];
    if (calendarIds.length === 0) return { items: [], truncated: false };
    const calendars = new Map(
      (
        await tx
          .select({ id: sourceCalendar.id, timezone: sourceCalendar.timezone, email: calendarAccount.email })
          .from(sourceCalendar)
          .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
          .where(inArray(sourceCalendar.id, calendarIds))
      ).map((c) => [c.id, { zone: c.timezone ?? 'UTC', addresses: c.email ? [`mailto:${c.email}`] : [] }]),
    );
    const resources = await resourcesIn(tx, calendarIds, range);
    const uidSecret = await openUidSecret(secrets, target);
    const window = { from: Temporal.Instant.fromEpochMilliseconds(range.from.getTime()), to: Temporal.Instant.fromEpochMilliseconds(range.to.getTime()) };

    const items: OccurrenceItem[] = [];
    let truncated = false;
    for (const p of chosen) {
      // Sources by priority, so a UID's zone is that of its highest-priority copy.
      const inputs: SourceResource[] = p.sources.flatMap((s) =>
        resources
          .filter((r) => r.sourceCalendarId === s.calendarId)
          .map((r) => ({ sourceCalendarId: s.calendarId, priority: s.priority, ownerAddresses: calendars.get(s.calendarId)?.addresses ?? [], resource: r.data })),
      );
      const zoneOf = new Map<string, string>();
      for (const input of inputs) if (!zoneOf.has(input.resource.uid)) zoneOf.set(input.resource.uid, calendars.get(input.sourceCalendarId as SourceCalendarId)?.zone ?? 'UTC');
      const spec = {
        id: p.id,
        kind: p.kind,
        privacy: p.privacy,
        filters: p.filters,
        keepAlarms: p.keepAlarms,
        ownerAddresses: [...new Set(inputs.flatMap((i) => i.ownerAddresses))],
        uidSecret,
      };
      for (const object of await project(spec, inputs)) {
        let expansion;
        try {
          expansion = expandOccurrences(object.resource, window, zoneOf.get(object.sourceUid), MAX_OCCURRENCES);
        } catch (error) {
          if (error instanceof UnknownTimeZoneError) continue;
          throw error;
        }
        truncated ||= expansion.truncated;
        for (const o of expansion.occurrences) {
          const location = p.privacy === 'full' ? textValue(o.component, 'location') : null;
          items.push({
            publicationId: p.id,
            outputUid: object.outputUid,
            recurrenceId: o.recurrenceId,
            start: o.start.toString(),
            end: o.end.toString(),
            allDay: o.allDay,
            summary: summary(o.component) ?? '',
            ...(location !== null && { location }),
            color: p.color,
          });
        }
      }
    }
    items.sort((a, b) => a.start.localeCompare(b.start) || a.publicationId.localeCompare(b.publicationId));
    return { items: items.slice(0, MAX_OCCURRENCES), truncated: truncated || items.length > MAX_OCCURRENCES };
  }

  return {
    getOrCreateDefaultFeed,
    ensurePassthroughPublication,
    onCalendarGone,
    listFeeds,
    getFeed: loadFeed,
    createFeed,
    updateFeed,
    deleteFeed,
    rotateCaldavPassword,
    rotateIcsToken,
    listPublications,
    getPublication,
    createPublication,
    updatePublication,
    deletePublication,
    reorderPublications,
    previewOccurrences,
  };
}
