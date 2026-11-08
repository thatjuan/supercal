/**
 * Renders ICS feeds (architecture §9): one publication, or a feed's combined `all.ics`, projected
 * (§5) and serialised with the VTIMEZONEs its events reference. `enabledPublications` is what the
 * endpoints read before deciding whether to render at all.
 */
import { project, projectCombined, serializeCalendar, type JCalProperty, type PublicationSpec, type SourceResource } from '@supercal/core';
import {
  calendarAccount,
  publication,
  publicationSource,
  resourcesIn,
  sourceCalendar,
  type Feed,
  type FeedId,
  type LiveResource,
  type Publication,
  type PublicationSource,
  type SecretBox,
  type SourceCalendarId,
  type TenantTx,
} from '@supercal/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { openUidSecret } from '../feeds/credentials.ts';

/** How often we ask clients to poll. Google and Outlook ignore it (spike Q8). */
const REFRESH = 'PT1H';

/** A publication with its source calendars, highest priority (lowest number) first. */
export type IcsPublication = Publication & { sources: Pick<PublicationSource, 'sourceCalendarId' | 'priority'>[] };

/** The feed's enabled publications by `sort_order`, then id. */
export async function enabledPublications(tx: TenantTx, feedId: FeedId): Promise<IcsPublication[]> {
  const rows = await tx
    .select({ publication, sourceCalendarId: publicationSource.sourceCalendarId, priority: publicationSource.priority })
    .from(publication)
    .innerJoin(publicationSource, eq(publicationSource.publicationId, publication.id))
    .where(and(eq(publication.feedId, feedId), eq(publication.enabled, true)))
    .orderBy(asc(publication.sortOrder), asc(publication.id), asc(publicationSource.priority), asc(publicationSource.sourceCalendarId));
  const byId = new Map<string, IcsPublication>();
  for (const { publication: row, ...source } of rows) {
    let found = byId.get(row.id);
    if (!found) byId.set(row.id, (found = { ...row, sources: [] }));
    found.sources.push(source);
  }
  return [...byId.values()];
}

/** Text escaping of RFC 5545 §3.3.11, for properties ical.js does not know (it writes `unknown` values as is). */
const escapeText = (value: string) => value.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
const raw = (name: string, value: string): JCalProperty => [name, {}, 'unknown', value];

function calendarProps(name: string, color: string | null): JCalProperty[] {
  return [
    raw('calscale', 'GREGORIAN'),
    raw('method', 'PUBLISH'),
    raw('name', escapeText(name)),
    raw('x-wr-calname', escapeText(name)),
    ...(color ? [raw('color', color)] : []),
    ['refresh-interval', {}, 'duration', REFRESH],
    raw('x-published-ttl', REFRESH),
  ];
}

export type RenderTarget = {
  feed: Feed;
  /** One publication, or every enabled one for the combined feed. */
  publications: IcsPublication[];
  combined: boolean;
};

/**
 * The VCALENDAR text of `target`. The combined feed is named after the feed and dedupes by source
 * UID, first publication by `sort_order` winning (`projectCombined`).
 */
export async function renderIcs(tx: TenantTx, secrets: SecretBox, { feed, publications, combined }: RenderTarget): Promise<string> {
  const calendarIds = [...new Set(publications.flatMap((p) => p.sources.map((s) => s.sourceCalendarId)))];
  const owners = new Map<SourceCalendarId, string[]>();
  const bySource = new Map<SourceCalendarId, LiveResource[]>();
  if (calendarIds.length > 0) {
    const calendars = await tx
      .select({ id: sourceCalendar.id, email: calendarAccount.email })
      .from(sourceCalendar)
      .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
      .where(inArray(sourceCalendar.id, calendarIds));
    for (const { id, email } of calendars) owners.set(id, email ? [`mailto:${email}`] : []);
    for (const row of await resourcesIn(tx, calendarIds)) bySource.set(row.sourceCalendarId, [...(bySource.get(row.sourceCalendarId) ?? []), row]);
  }

  const uidSecret = await openUidSecret(secrets, feed, tx);
  const projections = publications.map((p) => {
    const inputs: SourceResource[] = p.sources.flatMap((s) =>
      (bySource.get(s.sourceCalendarId) ?? []).map((r) => ({
        sourceCalendarId: s.sourceCalendarId,
        priority: s.priority,
        ownerAddresses: owners.get(s.sourceCalendarId) ?? [],
        resource: r.data,
      })),
    );
    const spec: PublicationSpec = {
      id: p.id,
      kind: p.kind,
      privacy: p.privacy,
      filters: p.filters,
      keepAlarms: p.keepAlarms,
      ownerAddresses: [...new Set(inputs.flatMap((i) => i.ownerAddresses))],
      uidSecret,
    };
    return { spec, sortOrder: p.sortOrder, inputs };
  });

  const [single] = projections;
  const objects = combined ? await projectCombined(projections) : single ? await project(single.spec, single.inputs) : [];
  const name = combined ? feed.name : (publications[0]?.name ?? feed.name);
  const color = combined ? null : (publications[0]?.color ?? null);
  return serializeCalendar({ props: calendarProps(name, color), resources: objects.map((o) => o.resource) });
}
