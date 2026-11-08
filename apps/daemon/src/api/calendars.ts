/**
 * Source calendars (architecture §3, §12): what discovery found on each account, with how fresh
 * its data is and which publications serve it. Members see their own accounts' calendars; admins
 * every calendar in the tenant.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { calendarAccount, calendarState, publicationSource, sourceCalendar, withTenant, type SourceCalendar, type TenantTx } from '@supercal/db';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { canManageOwned, hasRole } from '../auth/policy.ts';
import type { Principal } from '../auth/principal.ts';
import { createApiApp, Forbidden, NotFound, problemResponses, typeId } from './kit/index.ts';

export const Calendar = z
  .object({
    id: typeId('cal'),
    accountId: typeId('acc'),
    name: z.string(),
    color: z.string().nullable(),
    timezone: z.string().nullable().openapi({ description: 'IANA zone, when the provider names one' }),
    state: z.enum(calendarState.enumValues).openapi({ description: '`gone`: no longer listed by the provider' }),
    capabilities: z.object({ incremental: z.string(), push: z.boolean() }),
    freshness: z
      .object({
        lastSuccessAt: z.iso.datetime().nullable(),
        pushActive: z.boolean(),
        expectedLatency: z.int().nullable().openapi({ description: 'Seconds until changes are expected to show (the current poll interval)' }),
        stale: z.boolean().openapi({ description: 'The account cannot sync (e.g. reauth required); the last good data is still published' }),
      })
      .openapi({ description: 'Observed, never promised' }),
    publicationIds: z.array(typeId('pub')),
  })
  .openapi('Calendar');
const CalendarList = z.object({ items: z.array(Calendar) }).openapi('CalendarList');

/** The API shape of `calendars`, with the publications that serve each. */
export async function toCalendars(tx: TenantTx, calendars: SourceCalendar[]): Promise<z.infer<typeof Calendar>[]> {
  const links =
    calendars.length === 0
      ? []
      : await tx
          .select()
          .from(publicationSource)
          .where(
            inArray(
              publicationSource.sourceCalendarId,
              calendars.map((c) => c.id),
            ),
          )
          .orderBy(asc(publicationSource.publicationId));
  return calendars.map(({ id, accountId, name, color, timezone, state, capabilities, freshness }) => ({
    id,
    accountId,
    name,
    color,
    timezone,
    state,
    capabilities,
    freshness: {
      lastSuccessAt: freshness.lastSuccessAt,
      pushActive: freshness.pushActive,
      expectedLatency: freshness.expectedLatencyMs === null ? null : Math.round(freshness.expectedLatencyMs / 1000),
      stale: freshness.stale,
    },
    publicationIds: links.filter((l) => l.sourceCalendarId === id).map((l) => l.publicationId),
  }));
}

/** Calendars matching `where` that `principal` may see. */
async function visibleCalendars(tx: TenantTx, principal: Principal, where?: SQL) {
  const own = hasRole(principal, 'admin') ? undefined : eq(calendarAccount.ownerUserId, principal.userId);
  const rows = await tx
    .select({ calendar: sourceCalendar })
    .from(sourceCalendar)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
    .where(and(own, where))
    .orderBy(asc(sourceCalendar.accountId), asc(sourceCalendar.name), asc(sourceCalendar.id));
  return rows.map((r) => r.calendar);
}

const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Calendars'];

const listCalendars = createRoute({
  method: 'get',
  path: '/api/v1/calendars',
  operationId: 'listCalendars',
  tags,
  request: { query: z.object({ accountId: typeId('acc').optional() }) },
  responses: { 200: json('Calendars of the accounts you manage', CalendarList), ...problemResponses(400, 401, 403) },
});

const getCalendar = createRoute({
  method: 'get',
  path: '/api/v1/calendars/{id}',
  operationId: 'getCalendar',
  tags,
  request: { params: z.object({ id: typeId('cal') }) },
  responses: { 200: json('The calendar', Calendar), ...problemResponses(400, 401, 403, 404) },
});

export const calendarRoutes = createApiApp()
  .openapi(listCalendars, async (c) => {
    const { accountId } = c.req.valid('query');
    const items = await withTenant(c.var.principal.tenantId, async (tx) =>
      toCalendars(tx, await visibleCalendars(tx, c.var.principal, accountId && eq(sourceCalendar.accountId, accountId))),
    );
    return c.json({ items }, 200);
  })
  .openapi(getCalendar, async (c) => {
    const { id } = c.req.valid('param');
    const { principal } = c.var;
    const [item] = await withTenant(principal.tenantId, async (tx) => {
      const [row] = await tx
        .select({ calendar: sourceCalendar, ownerUserId: calendarAccount.ownerUserId })
        .from(sourceCalendar)
        .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
        .where(eq(sourceCalendar.id, id));
      if (!row) throw new NotFound('No such calendar');
      if (!canManageOwned(principal, row.ownerUserId)) throw new Forbidden('You can only see your own calendars');
      return toCalendars(tx, [row.calendar]);
    });
    if (!item) throw new NotFound('No such calendar');
    return c.json(item, 200);
  });
