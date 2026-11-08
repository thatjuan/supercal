/**
 * Sinks (architecture §11, §12): mirror a publication into a calendar Supercal creates in one of
 * the owner's Google accounts. Members see and manage their own; admins every sink in the tenant.
 * `POST` answers 409 `needs-consent` with an `authorizationUrl` until the account has granted
 * `calendar.app.created`; after consent the browser lands on `returnTo` and the client posts again.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { createSink, deleteSink, getSink, listSinks } from '../sinks/service.ts';
import { createApiApp, Problem, problemResponses, typeId } from './kit/index.ts';

export const Sink = z
  .object({
    id: typeId('snk'),
    publicationId: typeId('pub'),
    accountId: typeId('acc'),
    calendarId: z.string().openapi({ description: 'The Google calendar the sink writes' }),
    status: z.enum(['syncing', 'up_to_date', 'error', 'calendar_missing']).openapi({
      description: '`calendar_missing`: the calendar was deleted in Google and the sink stopped; remove the sink, or remove and create it again',
    }),
    lastWriteAt: z.iso.datetime().nullable(),
    error: z.string().nullable(),
    counts: z.object({ events: z.int().openapi({ description: 'Objects mirrored into the calendar' }) }),
    createdAt: z.iso.datetime(),
  })
  .openapi('Sink');
const SinkList = z.object({ items: z.array(Sink) }).openapi('SinkList');

const NewSink = z
  .object({
    publicationId: typeId('pub'),
    accountId: typeId('acc'),
    returnTo: z
      .string()
      .min(1)
      .max(2048)
      .default('/')
      .openapi({ description: 'Where Google sends the browser back after consent, when consent is needed' }),
  })
  .openapi('NewSink');

const NeedsConsentProblem = Problem.extend({ authorizationUrl: z.url() }).openapi('NeedsConsentProblem', {
  description: '`type` …/problems/needs-consent: send the browser to `authorizationUrl`, then create the sink again. Any other 409: the sink exists already',
});

const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Sinks'];
const params = z.object({ id: typeId('snk') });

const listSinksRoute = createRoute({
  method: 'get',
  path: '/api/v1/sinks',
  operationId: 'listSinks',
  tags,
  responses: { 200: json('Your sinks (admins: the tenant’s)', SinkList), ...problemResponses(401, 403) },
});

const createSinkRoute = createRoute({
  method: 'post',
  path: '/api/v1/sinks',
  operationId: 'createSink',
  tags,
  request: { body: { required: true, content: { 'application/json': { schema: NewSink } } } },
  responses: {
    201: json('The sink; its calendar exists and its events are being written', Sink),
    ...problemResponses(400, 401, 403, 422, 503),
    409: { description: 'Consent is needed, or the sink exists already', content: { 'application/problem+json': { schema: NeedsConsentProblem } } },
  },
});

const getSinkRoute = createRoute({
  method: 'get',
  path: '/api/v1/sinks/{id}',
  operationId: 'getSink',
  tags,
  request: { params },
  responses: { 200: json('The sink', Sink), ...problemResponses(400, 401, 403, 404) },
});

const deleteSinkRoute = createRoute({
  method: 'delete',
  path: '/api/v1/sinks/{id}',
  operationId: 'deleteSink',
  tags,
  request: {
    params,
    query: z.object({
      deleteCalendar: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true')
        .openapi({ description: 'Also delete the Google calendar; otherwise it stays in Google, no longer updated' }),
    }),
  },
  responses: { 204: { description: 'Removed' }, ...problemResponses(400, 401, 403, 404, 503) },
});

export const sinkRoutes = createApiApp()
  .openapi(listSinksRoute, async (c) => c.json({ items: await listSinks(c.var.principal) }, 200))
  .openapi(createSinkRoute, async (c) => c.json(await createSink(c.var.sync, c.var.oauth, c.var.principal, c.req.valid('json')), 201))
  .openapi(getSinkRoute, async (c) => c.json(await getSink(c.var.principal, c.req.valid('param').id), 200))
  .openapi(deleteSinkRoute, async (c) => {
    await deleteSink(c.var.sync, c.var.principal, c.req.valid('param').id, c.req.valid('query'));
    return c.body(null, 204);
  });
