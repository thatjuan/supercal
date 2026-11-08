import { createRoute, z } from '@hono/zod-openapi';
import { Temporal } from '@js-temporal/polyfill';
import { freeBusy } from '@supercal/core';
import { resourcesIn, withTenant } from '@supercal/db';
import { accessibleCalendars } from '../hosted/access.ts';
import { BadRequest, createApiApp, problemResponses, typeId } from './kit/index.ts';

const Result = z.union([
  z.object({ busy: z.array(z.object({ start: z.iso.datetime(), end: z.iso.datetime(), status: z.enum(['busy', 'tentative']) })), truncated: z.boolean() }),
  z.object({ error: z.literal('not-accessible') }),
]);
const route = createRoute({ method: 'post', path: '/api/v1/free-busy', operationId: 'queryFreeBusy', tags: ['Free-busy'],
  request: { body: { required: true, content: { 'application/json': { schema: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), calendarIds: z.array(typeId('cal')).max(50) }) } } } },
  responses: { 200: { description: 'Busy intervals; inaccessible and absent calendars are indistinguishable', content: { 'application/json': { schema: z.object({ calendars: z.record(z.string(), Result) }) } } }, ...problemResponses(400, 401, 403) },
});
export const freeBusyRoutes = createApiApp().openapi(route, async (c) => {
  const input = c.req.valid('json'), from = Temporal.Instant.from(input.from), to = Temporal.Instant.from(input.to);
  if (Temporal.Instant.compare(from, to) >= 0 || to.epochMilliseconds - from.epochMilliseconds > 62 * 86400_000) throw new BadRequest([{ path: 'to', message: 'Window must be positive and at most 62 days' }]);
  const calendars = await withTenant(c.var.principal.tenantId, async (tx) => {
    const visible = new Map((await accessibleCalendars(tx, c.var.principal, 'free-busy')).map(({ calendar }) => [calendar.id, calendar]));
    const results: Record<string, z.infer<typeof Result>> = {};
    for (const id of new Set(input.calendarIds)) {
      const calendar = visible.get(id);
      if (!calendar || calendar.state !== 'active') { results[id] = { error: 'not-accessible' }; continue; }
      const rows = await resourcesIn(tx, [id], { from: new Date(from.epochMilliseconds), to: new Date(to.epochMilliseconds) });
      const result = freeBusy(rows.map((row) => row.data), { from, to }, calendar.timezone ?? 'UTC');
      results[id] = { busy: result.intervals.map((interval) => ({ start: interval.start.toString(), end: interval.end.toString(), status: interval.status })), truncated: result.truncated };
    }
    return results;
  });
  return c.json({ calendars }, 200);
});
