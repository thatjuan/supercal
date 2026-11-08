/**
 * Source calendars (architecture §3, §12): connected and hosted calendars, with how fresh
 * their data is and which publications serve it. Members see their own accounts' calendars; admins
 * every calendar in the tenant.
 */
import { assertIanaZone } from '@supercal/core';
import { createRoute, z } from '@hono/zod-openapi';
import { calendarAccount, calendarState, publicationSource, sourceCalendar, withTenant, type SourceCalendar, type TenantTx } from '@supercal/db';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { canManageOwned, hasRole } from '../auth/policy.ts';
import type { Principal } from '../auth/principal.ts';
import { createCalendar, deleteCalendar, restoreCalendar } from '../hosted/calendars.ts';
import { lockHostedCalendar } from '../hosted/objects.ts';
import { audit, createApiApp, etagOf, ifMatchHeaders, requireIfMatch, Forbidden, NotFound, ProblemError, problemResponses, typeId } from './kit/index.ts';

const CalendarFields = z
  .object({
    id: typeId('cal'),
    description: z.string().nullable(),
    sortOrder: z.int(),
    updatedAt: z.iso.datetime(),
    goneAt: z.iso.datetime().nullable(),
    name: z.string(),
    color: z.string().nullable(),
    timezone: z.string().nullable().openapi({ description: 'IANA zone, when the provider names one' }),
    state: z.enum(calendarState.enumValues).openapi({ description: '`gone`: removed by the provider or soft-deleted by the hosted calendar owner' }),
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
  });
export const Calendar = z.discriminatedUnion('kind', [
  CalendarFields.extend({ kind: z.literal('hosted'), accountId: z.null() }).openapi('HostedCalendar'),
  CalendarFields.extend({ kind: z.literal('connected'), accountId: typeId('acc') }).openapi('ConnectedCalendar'),
]).openapi('Calendar');
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
  const accounts = calendars.length === 0 ? [] : await tx
    .select({ id: calendarAccount.id, provider: calendarAccount.provider })
    .from(calendarAccount)
    .where(inArray(calendarAccount.id, calendars.map((c) => c.accountId)));
  const hostedIds = new Set(accounts.filter((account) => account.provider === 'hosted').map((account) => account.id));
  return calendars.map(({ id, accountId, name, color, timezone, state, capabilities, freshness, description, sortOrder, updatedAt, goneAt }) => ({
    description,
    sortOrder,
    updatedAt: updatedAt.toISOString(),
    goneAt: goneAt?.toISOString() ?? null,
    id,
    ...(hostedIds.has(accountId) ? { kind: 'hosted' as const, accountId: null } : { kind: 'connected' as const, accountId }),
    name,
    color,
    timezone,
    state,
    capabilities,
    freshness: hostedIds.has(accountId) ? { lastSuccessAt: null, pushActive: false, expectedLatency: 0, stale: false } : {
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

const params = z.object({ id: typeId('cal') });
const CalendarInput = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().refine((zone) => {
    try {
      assertIanaZone(zone);
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA timezone').optional(),
  description: z.string().max(10000).optional(),
});
const body = <T extends z.ZodType>(schema: T) => ({ required: true as const, content: { 'application/json': { schema } } });
const addCalendar = createRoute({
  method: 'post',
  path: '/api/v1/calendars',
  operationId: 'createCalendar',
  tags,
  request: { body: body(CalendarInput) },
  responses: { 201: json('Created hosted calendar; its publication starts disabled', Calendar), ...problemResponses(400, 401, 403, 409) },
});

const patchCalendar = createRoute({
  method: 'patch',
  path: '/api/v1/calendars/{id}',
  operationId: 'updateCalendar',
  tags,
  description: 'Updates a hosted calendar. Changing timezone does not recompute spans of floating events.',
  request: { params, headers: ifMatchHeaders, body: body(CalendarInput.partial().extend({ sortOrder: z.int().optional() })) },
  responses: { 200: json('Updated calendar', Calendar), ...problemResponses(400, 401, 403, 404, 409, 412) },
});

const removeCalendar = createRoute({
  method: 'delete',
  path: '/api/v1/calendars/{id}',
  operationId: 'deleteCalendar',
  tags,
  request: { params },
  responses: { 204: { description: 'Soft deleted; retained for 30 days' }, ...problemResponses(400, 401, 403, 404, 409) },
});

const recoverCalendar = createRoute({
  method: 'post',
  path: '/api/v1/calendars/{id}/restore',
  operationId: 'restoreCalendar',
  tags,
  description: 'Restores a deleted hosted calendar. Publications remain disabled and virtual memberships remain removed; the owner re-enables them.',
  request: { params },
  responses: { 200: json('Restored calendar', Calendar), ...problemResponses(400, 401, 403, 404, 409) },
});

/** Authorizes calendar management and serializes metadata changes with event writes. */
async function managedHosted(tx: TenantTx, principal: Principal, id: SourceCalendar['id']) {
  await lockHostedCalendar(tx, id);
  const [row] = await tx
    .select({ calendar: sourceCalendar, ownerUserId: calendarAccount.ownerUserId, provider: calendarAccount.provider })
    .from(sourceCalendar)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
    .where(eq(sourceCalendar.id, id));
  if (!row) throw new NotFound('No such calendar');
  if (!canManageOwned(principal, row.ownerUserId)) throw new Forbidden('You can only manage your own calendars');
  if (row.provider !== 'hosted') throw new ProblemError(409, 'Calendar is not hosted', undefined, 'calendar-not-hosted');
  return row.calendar;
}

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
    return c.json(item, 200, { ETag: etagOf({ id: item.id, updatedAt: new Date(item.updatedAt) }) });
  })
  .openapi(addCalendar, async (c) => {
    const { principal, feeds } = c.var;
    const row = await withTenant(principal.tenantId, async (tx) => {
      const calendar = await createCalendar(tx, feeds, principal.userId, c.req.valid('json'));
      await audit(tx, principal, 'calendar.create', { type: 'calendar', id: calendar.id });
      return (await toCalendars(tx, [calendar]))[0]!;
    });
    return c.json(row, 201, { ETag: etagOf({ id: row.id, updatedAt: new Date(row.updatedAt) }) });
  })
  .openapi(patchCalendar, async (c) => {
    const { principal } = c.var;
    const row = await withTenant(principal.tenantId, async (tx) => {
      const calendar = await managedHosted(tx, principal, c.req.valid('param').id);
      requireIfMatch(c, etagOf(calendar));
      const [updated] = await tx.update(sourceCalendar).set({ ...c.req.valid('json'), updatedAt: new Date() }).where(eq(sourceCalendar.id, calendar.id)).returning();
      if (!updated) throw new NotFound('No such calendar');
      await audit(tx, principal, 'calendar.update', { type: 'calendar', id: calendar.id });
      return (await toCalendars(tx, [updated]))[0]!;
    });
    return c.json(row, 200, { ETag: etagOf({ id: row.id, updatedAt: new Date(row.updatedAt) }) });
  })
  .openapi(removeCalendar, async (c) => {
    const { principal, feeds } = c.var;
    await withTenant(principal.tenantId, async (tx) => {
      const calendar = await managedHosted(tx, principal, c.req.valid('param').id);
      await deleteCalendar(tx, feeds, calendar.id);
      await audit(tx, principal, 'calendar.delete', { type: 'calendar', id: calendar.id });
    });
    return c.body(null, 204);
  })
  .openapi(recoverCalendar, async (c) => {
    const { principal } = c.var;
    const row = await withTenant(principal.tenantId, async (tx) => {
      const calendar = await managedHosted(tx, principal, c.req.valid('param').id);
      const restored = await restoreCalendar(tx, calendar.id);
      await audit(tx, principal, 'calendar.restore', { type: 'calendar', id: calendar.id });
      return (await toCalendars(tx, [restored]))[0]!;
    });
    return c.json(row, 200, { ETag: etagOf({ id: row.id, updatedAt: new Date(row.updatedAt) }) });
  });
