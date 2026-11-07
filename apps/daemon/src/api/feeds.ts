/**
 * Feeds (architecture §7, §12): a user's set of publications behind one CalDAV login and one ICS
 * token. Credentials are returned only by create and rotate; reads expose the CalDAV username alone.
 * `GET /feeds/{id}/occurrences` previews exactly what the feed publishes.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { withTenant, type Feed as FeedRow } from '@supercal/db';
import type { Publication as PublicationRow } from '../feeds/service.ts';
import { BadRequest, createApiApp, etagOf, ifMatchHeaders, problemResponses, requireIfMatch, typeId } from './kit/index.ts';

/** The preview's widest window. */
const MAX_WINDOW_DAYS = 62;

const Feed = z
  .object({ id: typeId('feed'), ownerUserId: z.string(), name: z.string(), isDefault: z.boolean(), caldavUsername: z.string() })
  .openapi('Feed');
const FeedList = z.object({ items: z.array(Feed) }).openapi('FeedList');

const IcsUrls = z
  .object({ combined: z.url(), publications: z.array(z.object({ publicationId: typeId('pub'), url: z.url() })) })
  .openapi('IcsUrls', { description: 'The combined feed and each enabled publication' });
const CaldavCredentials = z
  .object({ username: z.string(), password: z.string().openapi({ description: 'Shown only in this response' }) })
  .openapi('CaldavCredentials');
const IcsCredentials = z
  .object({ token: z.string().openapi({ description: 'Shown only in this response' }), urls: IcsUrls })
  .openapi('IcsCredentials');
const CreatedFeed = z.object({ feed: Feed, credentials: z.object({ caldav: CaldavCredentials, ics: IcsCredentials }) }).openapi('CreatedFeed');

const Occurrence = z
  .object({
    publicationId: typeId('pub'),
    outputUid: z.string(),
    recurrenceId: z.string(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    allDay: z.boolean(),
    summary: z.string(),
    location: z.string().optional().openapi({ description: 'Only for full-privacy publications' }),
    color: z.string().nullable(),
  })
  .openapi('Occurrence');
const OccurrenceList = z.object({ items: z.array(Occurrence), truncated: z.boolean() }).openapi('OccurrenceList');

const params = z.object({ id: typeId('feed') });
const FeedName = z.object({ name: z.string().min(1).max(100) });
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Feeds'];

const listFeeds = createRoute({
  method: 'get',
  path: '/api/v1/feeds',
  operationId: 'listFeeds',
  tags,
  request: { query: z.object({ ownerUserId: z.string().optional().openapi({ description: 'Admins: another member’s feeds' }) }) },
  responses: { 200: json('The user’s feeds; the default feed is created on first access', FeedList), ...problemResponses(401, 403, 404) },
});

const createFeed = createRoute({
  method: 'post',
  path: '/api/v1/feeds',
  operationId: 'createFeed',
  tags,
  request: { body: { required: true, content: { 'application/json': { schema: FeedName } } } },
  responses: { 201: json('The new feed, with its credentials (shown only here)', CreatedFeed), ...problemResponses(400, 401, 403) },
});

const getFeed = createRoute({
  method: 'get',
  path: '/api/v1/feeds/{id}',
  operationId: 'getFeed',
  tags,
  request: { params },
  responses: { 200: json('The feed', Feed), ...problemResponses(400, 401, 403, 404) },
});

const updateFeed = createRoute({
  method: 'patch',
  path: '/api/v1/feeds/{id}',
  operationId: 'updateFeed',
  tags,
  request: { params, headers: ifMatchHeaders, body: { required: true, content: { 'application/json': { schema: FeedName } } } },
  responses: { 200: json('The renamed feed', Feed), ...problemResponses(400, 401, 403, 404, 412) },
});

const deleteFeed = createRoute({
  method: 'delete',
  path: '/api/v1/feeds/{id}',
  operationId: 'deleteFeed',
  tags,
  request: { params },
  responses: { 204: { description: 'Deleted, with its publications' }, ...problemResponses(400, 401, 403, 404, 409) },
});

const rotateCaldav = createRoute({
  method: 'post',
  path: '/api/v1/feeds/{id}/credentials/caldav/rotate',
  operationId: 'rotateFeedCaldavPassword',
  tags,
  request: { params },
  responses: { 200: json('A new app password; the old one stops working now', CaldavCredentials), ...problemResponses(400, 401, 403, 404) },
});

const rotateIcs = createRoute({
  method: 'post',
  path: '/api/v1/feeds/{id}/credentials/ics/rotate',
  operationId: 'rotateFeedIcsToken',
  tags,
  request: { params },
  responses: { 200: json('A new ICS token; old URLs stop working now', IcsCredentials), ...problemResponses(400, 401, 403, 404) },
});

const listOccurrences = createRoute({
  method: 'get',
  path: '/api/v1/feeds/{id}/occurrences',
  operationId: 'listFeedOccurrences',
  tags,
  request: {
    params,
    query: z.object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }).openapi({ description: `Exclusive; at most ${MAX_WINDOW_DAYS} days after \`from\`` }),
      publicationId: typeId('pub').optional().openapi({ description: 'Only this publication, even when disabled' }),
    }),
  },
  responses: { 200: json('Projected occurrences overlapping the window, by start (UTC)', OccurrenceList), ...problemResponses(400, 401, 403, 404) },
});

const toFeed = ({ id, ownerUserId, name, isDefault, caldavUsername }: FeedRow) => ({ id, ownerUserId, name, isDefault, caldavUsername });

/** The ICS URLs a token opens: the combined feed and each enabled publication. */
function icsUrls(publicUrl: string, token: string, publications: PublicationRow[]) {
  const base = `${publicUrl.replace(/\/$/, '')}/ics/${token}`;
  return {
    combined: `${base}/all.ics`,
    publications: publications.filter((p) => p.enabled).map((p) => ({ publicationId: p.id, url: `${base}/${p.slug}.ics` })),
  };
}

export const feedRoutes = createApiApp()
  .openapi(listFeeds, async (c) => {
    const { ownerUserId } = c.req.valid('query');
    const rows = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.listFeeds(tx, c.var.principal, ownerUserId));
    return c.json({ items: rows.map(toFeed) }, 200);
  })
  .openapi(createFeed, async (c) => {
    const { name } = c.req.valid('json');
    const created = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.createFeed(tx, c.var.principal, name));
    const { caldav, ics } = created.secrets;
    const credentials = { caldav, ics: { token: ics.token, urls: icsUrls(c.var.auth.publicUrl, ics.token, []) } };
    return c.json({ feed: toFeed(created.feed), credentials }, 201, { ETag: etagOf(created.feed) });
  })
  .openapi(getFeed, async (c) => {
    const { id } = c.req.valid('param');
    const row = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.getFeed(tx, c.var.principal, id));
    return c.json(toFeed(row), 200, { ETag: etagOf(row) });
  })
  .openapi(updateFeed, async (c) => {
    const { id } = c.req.valid('param');
    const changes = c.req.valid('json');
    const row = await withTenant(c.var.principal.tenantId, (tx) =>
      c.var.feeds.updateFeed(tx, c.var.principal, id, changes, (current) => requireIfMatch(c, etagOf(current))),
    );
    return c.json(toFeed(row), 200, { ETag: etagOf(row) });
  })
  .openapi(deleteFeed, async (c) => {
    const { id } = c.req.valid('param');
    await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.deleteFeed(tx, c.var.principal, id));
    return c.body(null, 204);
  })
  .openapi(rotateCaldav, async (c) => {
    const { id } = c.req.valid('param');
    return c.json(await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.rotateCaldavPassword(tx, c.var.principal, id)), 200);
  })
  .openapi(rotateIcs, async (c) => {
    const { id } = c.req.valid('param');
    const { token, publications } = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.rotateIcsToken(tx, c.var.principal, id));
    return c.json({ token, urls: icsUrls(c.var.auth.publicUrl, token, publications) }, 200);
  })
  .openapi(listOccurrences, async (c) => {
    const { id } = c.req.valid('param');
    const { from: rawFrom, to: rawTo, publicationId } = c.req.valid('query');
    const from = new Date(rawFrom);
    const to = new Date(rawTo);
    if (to <= from) throw new BadRequest([{ path: 'to', message: 'must be after from' }], '`to` must be after `from`');
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000)
      throw new BadRequest([{ path: 'to', message: `at most ${MAX_WINDOW_DAYS} days after from` }], `The window is at most ${MAX_WINDOW_DAYS} days`);
    const result = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.previewOccurrences(tx, c.var.principal, id, { from, to, publicationId }));
    return c.json(result, 200);
  });
