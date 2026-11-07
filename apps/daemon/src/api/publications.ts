/**
 * Publications (architecture §3): the calendars a feed serves. `Publication` is a discriminated
 * union on `kind`: a passthrough publication serves one source calendar, a virtual one merges two
 * or more. The feeds service validates sources and bumps epoch or config version on every change.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { withTenant } from '@supercal/db';
import type { Publication as PublicationRow } from '../feeds/service.ts';
import { createApiApp, etagOf, ifMatchHeaders, problemResponses, requireIfMatch, typeId } from './kit/index.ts';

const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a #RRGGBB colour');

export const Filters = z
  .object({ hideDeclined: z.boolean(), hideCancelled: z.boolean(), hideAllDay: z.boolean() })
  .openapi('PublicationFilters', { description: 'Hide events the owner declined, cancelled events, all-day events' });

const Privacy = z.enum(['full', 'title-only', 'busy-only']);

const Source = z.object({ calendarId: typeId('cal'), priority: z.int().openapi({ description: 'Lower wins merge ties' }) });

const base = {
  id: typeId('pub'),
  feedId: typeId('feed'),
  slug: z.string(),
  name: z.string(),
  color: Color.nullable(),
  privacy: Privacy,
  filters: Filters,
  keepAlarms: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.int(),
  status: z.enum(['ok', 'disabled-invalid']).openapi({ description: '`disabled-invalid`: disabled by Supercal; see `statusDetail`' }),
  statusDetail: z.string().nullable(),
};

const PassthroughPublication = z.object({ ...base, kind: z.literal('passthrough'), sourceCalendarId: typeId('cal') }).openapi('PassthroughPublication');
const VirtualPublication = z.object({ ...base, kind: z.literal('virtual'), sources: z.array(Source).min(2) }).openapi('VirtualPublication');

export const Publication = z.discriminatedUnion('kind', [PassthroughPublication, VirtualPublication]).openapi('Publication');
export const PublicationList = z.object({ items: z.array(Publication) }).openapi('PublicationList');

/** The API shape of a publication row. */
export function toPublication({ sources, kind, ...row }: PublicationRow): z.infer<typeof Publication> {
  const fields = {
    id: row.id,
    feedId: row.feedId,
    slug: row.slug,
    name: row.name,
    color: row.color,
    privacy: row.privacy,
    filters: row.filters,
    keepAlarms: row.keepAlarms,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    status: row.status,
    statusDetail: row.statusDetail,
  };
  const [first] = sources;
  if (kind === 'virtual') return { ...fields, kind, sources };
  if (!first) throw new Error(`passthrough publication ${row.id} has no source`);
  return { ...fields, kind, sourceCalendarId: first.calendarId };
}

const settings = { name: z.string().min(1).max(100), color: Color.nullable(), privacy: Privacy, filters: Filters, keepAlarms: z.boolean(), enabled: z.boolean() };
const SourceInput = z.object({ calendarId: typeId('cal'), priority: z.int().optional() });

const NewPublication = z
  .discriminatedUnion('kind', [
    z
      .object({ ...settings, kind: z.literal('passthrough'), sourceCalendarId: typeId('cal') })
      .partial({ name: true, color: true, privacy: true, filters: true, keepAlarms: true, enabled: true })
      .openapi('NewPassthroughPublication', { description: 'Name and colour default to the calendar’s' }),
    z
      .object({ ...settings, kind: z.literal('virtual'), sources: z.array(SourceInput).min(2) })
      .partial({ color: true, privacy: true, filters: true, keepAlarms: true, enabled: true })
      .openapi('NewVirtualPublication', { description: 'Source priority defaults to list position' }),
  ])
  .openapi('NewPublication');

const PublicationPatch = z
  .object({ ...settings, filters: Filters.partial(), sources: z.array(SourceInput).min(2).openapi({ description: 'Virtual publications only' }) })
  .partial()
  .openapi('PublicationPatch');

const feedParams = z.object({ id: typeId('feed') });
const params = z.object({ id: typeId('pub') });
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Publications'];

const listPublications = createRoute({
  method: 'get',
  path: '/api/v1/feeds/{id}/publications',
  operationId: 'listPublications',
  tags,
  request: { params: feedParams },
  responses: { 200: json('The feed’s publications, in order', PublicationList), ...problemResponses(400, 401, 403, 404) },
});

const createPublication = createRoute({
  method: 'post',
  path: '/api/v1/feeds/{id}/publications',
  operationId: 'createPublication',
  tags,
  request: { params: feedParams, body: { required: true, content: { 'application/json': { schema: NewPublication } } } },
  responses: { 201: json('The new publication, last in the feed', Publication), ...problemResponses(400, 401, 403, 404, 409) },
});

const reorderPublications = createRoute({
  method: 'put',
  path: '/api/v1/feeds/{id}/publications/order',
  operationId: 'reorderPublications',
  tags,
  request: {
    params: feedParams,
    body: { required: true, content: { 'application/json': { schema: z.object({ ids: z.array(typeId('pub')).openapi({ description: 'Every publication of the feed, in the new order' }) }) } } },
  },
  responses: { 200: json('The feed’s publications, in the new order', PublicationList), ...problemResponses(400, 401, 403, 404) },
});

const getPublication = createRoute({
  method: 'get',
  path: '/api/v1/publications/{id}',
  operationId: 'getPublication',
  tags,
  request: { params },
  responses: { 200: json('The publication', Publication), ...problemResponses(400, 401, 403, 404) },
});

const updatePublication = createRoute({
  method: 'patch',
  path: '/api/v1/publications/{id}',
  operationId: 'updatePublication',
  tags,
  request: { params, headers: ifMatchHeaders, body: { required: true, content: { 'application/json': { schema: PublicationPatch } } } },
  responses: { 200: json('The updated publication', Publication), ...problemResponses(400, 401, 403, 404, 409, 412) },
});

const deletePublication = createRoute({
  method: 'delete',
  path: '/api/v1/publications/{id}',
  operationId: 'deletePublication',
  tags,
  request: { params },
  responses: { 204: { description: 'Deleted' }, ...problemResponses(400, 401, 403, 404) },
});

const list = (rows: PublicationRow[]) => ({ items: rows.map(toPublication) });

export const publicationRoutes = createApiApp()
  .openapi(listPublications, async (c) => {
    const { id } = c.req.valid('param');
    const rows = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.listPublications(tx, c.var.principal, id));
    return c.json(list(rows), 200);
  })
  .openapi(createPublication, async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const row = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.createPublication(tx, c.var.principal, id, input));
    return c.json(toPublication(row), 201, { ETag: etagOf(row) });
  })
  .openapi(reorderPublications, async (c) => {
    const { id } = c.req.valid('param');
    const { ids } = c.req.valid('json');
    const rows = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.reorderPublications(tx, c.var.principal, id, ids));
    return c.json(list(rows), 200);
  })
  .openapi(getPublication, async (c) => {
    const { id } = c.req.valid('param');
    const row = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.getPublication(tx, c.var.principal, id));
    return c.json(toPublication(row), 200, { ETag: etagOf(row) });
  })
  .openapi(updatePublication, async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const row = await withTenant(c.var.principal.tenantId, (tx) =>
      c.var.feeds.updatePublication(tx, c.var.principal, id, patch, (current) => requireIfMatch(c, etagOf(current))),
    );
    return c.json(toPublication(row), 200, { ETag: etagOf(row) });
  })
  .openapi(deletePublication, async (c) => {
    const { id } = c.req.valid('param');
    await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.deletePublication(tx, c.var.principal, id));
    return c.body(null, 204);
  });
