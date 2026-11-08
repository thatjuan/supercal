/**
 * Source calendars (architecture §3, §12): connected and hosted calendars, with how fresh
 * their data is and which publications serve it. Lists include personal and tenant grants, with publication membership reserved for owners.
 */
import { assertIanaZone } from '@supercal/core';
import { createRoute, z } from '@hono/zod-openapi';
import { calendarAccount, calendarState, publicationSource, sourceCalendar, user, withTenant, type SourceCalendar, type TenantTx } from '@supercal/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { accessibleCalendars, ACCESS_LEVELS, requireAccess, type Access } from '../hosted/access.ts';
import type { Principal } from '../auth/principal.ts';
import { createCalendar, deleteCalendar, restoreCalendar } from '../hosted/calendars.ts';
import { lockHostedCalendar } from '../hosted/objects.ts';
import { audit, createApiApp, etagOf, ifMatchHeaders, requireIfMatch, NotFound, ProblemError, problemResponses, typeId } from './kit/index.ts';

const CalendarFields = z
  .object({
    id: typeId('cal'),
    description: z.string().nullable().optional(),
    sortOrder: z.int().optional(),
    updatedAt: z.iso.datetime().optional(),
    goneAt: z.iso.datetime().nullable().optional(),
    name: z.string(),
    color: z.string().nullable(),
    timezone: z.string().nullable().openapi({ description: 'IANA zone, when the provider names one' }),
    state: z.enum(calendarState.enumValues).openapi({ description: '`gone`: removed by the provider or soft-deleted by the hosted calendar owner' }),
    capabilities: z.object({ incremental: z.string(), push: z.boolean() }).optional(),
    access: z.enum([...ACCESS_LEVELS, 'owner']),
    owner: z.object({ id: z.string(), name: z.string() }),
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
  CalendarFields.extend({ kind: z.literal('hosted'), accountId: z.null().optional() }).openapi('HostedCalendar'),
  CalendarFields.extend({ kind: z.literal('connected'), accountId: typeId('acc').optional() }).openapi('ConnectedCalendar'),
]).openapi('Calendar');
const CalendarList = z.object({ items: z.array(Calendar) }).openapi('CalendarList');

/** Calendar metadata, with private publication membership visible only to owners and admins. */
export async function toCalendars(tx: TenantTx, calendars: SourceCalendar[], grants?: { calendar: SourceCalendar; access: Access }[]): Promise<z.infer<typeof Calendar>[]> {
  if (!calendars.length) return [];
  const accounts = await tx.select({ id: calendarAccount.id, provider: calendarAccount.provider, ownerId: user.id, ownerName: user.name })
    .from(calendarAccount).innerJoin(user, eq(user.id, calendarAccount.ownerUserId))
    .where(inArray(calendarAccount.id, calendars.map((c) => c.accountId)));
  const byAccount = new Map(accounts.map((account) => [account.id, account]));
  const byId = new Map(grants?.map((grant) => [grant.calendar.id, grant.access]));
  const published = calendars.filter((c) => (byId.get(c.id) ?? 'owner') === 'owner');
  const links = published.length ? await tx.select().from(publicationSource)
    .where(inArray(publicationSource.sourceCalendarId, published.map((c) => c.id))).orderBy(asc(publicationSource.publicationId)) : [];
  return calendars.map((calendar) => {
    const account = byAccount.get(calendar.accountId)!;
    const access = byId.get(calendar.id) ?? 'owner';
    const hosted = account.provider === 'hosted';
    return {
      id: calendar.id, name: calendar.name, color: calendar.color, timezone: calendar.timezone, state: calendar.state, access,
      owner: { id: account.ownerId, name: account.ownerName },
      ...(hosted ? { kind: 'hosted' as const, ...(access !== 'free-busy' && { accountId: null }) } : { kind: 'connected' as const, ...(access !== 'free-busy' && { accountId: calendar.accountId }) }),
      ...(access === 'free-busy' ? {} : {
        description: calendar.description, sortOrder: calendar.sortOrder,
        updatedAt: calendar.updatedAt.toISOString(), goneAt: calendar.goneAt?.toISOString() ?? null, capabilities: calendar.capabilities,
      }),
      freshness: hosted || access === 'free-busy' ? { lastSuccessAt: null, pushActive: false, expectedLatency: 0, stale: false } : {
        lastSuccessAt: calendar.freshness.lastSuccessAt, pushActive: calendar.freshness.pushActive,
        expectedLatency: calendar.freshness.expectedLatencyMs === null ? null : Math.round(calendar.freshness.expectedLatencyMs / 1000), stale: calendar.freshness.stale,
      },
      publicationIds: links.filter((link) => link.sourceCalendarId === calendar.id).map((link) => link.publicationId),
    };
  });
}

const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['Calendars'];

const listCalendars = createRoute({
  method: 'get',
  path: '/api/v1/calendars',
  operationId: 'listCalendars',
  tags,
  request: { query: z.object({ accountId: typeId('acc').optional() }) },
  responses: { 200: json('Accessible calendars, including free-busy grants', CalendarList), ...problemResponses(400, 401, 403) },
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
async function managedHosted(tx: TenantTx, principal: Principal, id: SourceCalendar['id'], min: 'manage' | 'owner' = 'owner') {
  await lockHostedCalendar(tx, id);
  const { calendar } = await requireAccess(tx, principal, id, min);
  const [account] = await tx.select({ provider: calendarAccount.provider }).from(calendarAccount).where(eq(calendarAccount.id, calendar.accountId));
  if (account?.provider !== 'hosted') throw new ProblemError(409, 'Calendar is not hosted', undefined, 'calendar-not-hosted');
  return calendar;
}

export const calendarRoutes = createApiApp()
  .openapi(listCalendars, async (c) => {
    const { accountId } = c.req.valid('query');
    const items = await withTenant(c.var.principal.tenantId, async (tx) => {
      const grants = (await accessibleCalendars(tx, c.var.principal, 'free-busy')).filter(({ calendar }) => !accountId || calendar.accountId === accountId);
      return toCalendars(tx, grants.map(({ calendar }) => calendar), grants);
    });
    return c.json({ items }, 200);
  })
  .openapi(getCalendar, async (c) => {
    const { id } = c.req.valid('param');
    const { principal } = c.var;
    const [item] = await withTenant(principal.tenantId, async (tx) => {
      const grant = await requireAccess(tx, principal, id, 'free-busy');
      return toCalendars(tx, [grant.calendar], [grant]);
    });
    if (!item) throw new NotFound('No such calendar');
    return c.json(item, 200, { ETag: etagOf({ id: item.id, updatedAt: new Date(item.updatedAt ?? 0) }) });
  })
  .openapi(addCalendar, async (c) => {
    const { principal, feeds } = c.var;
    const row = await withTenant(principal.tenantId, async (tx) => {
      const calendar = await createCalendar(tx, feeds, principal.userId, c.req.valid('json'));
      await audit(tx, principal, 'calendar.create', { type: 'calendar', id: calendar.id });
      return (await toCalendars(tx, [calendar]))[0]!;
    });
    return c.json(row, 201, { ETag: etagOf({ id: row.id, updatedAt: new Date(row.updatedAt!) }) });
  })
  .openapi(patchCalendar, async (c) => {
    const { principal } = c.var;
    const row = await withTenant(principal.tenantId, async (tx) => {
      const calendar = await managedHosted(tx, principal, c.req.valid('param').id, 'manage');
      requireIfMatch(c, etagOf(calendar));
      const [updated] = await tx.update(sourceCalendar).set({ ...c.req.valid('json'), updatedAt: new Date() }).where(eq(sourceCalendar.id, calendar.id)).returning();
      if (!updated) throw new NotFound('No such calendar');
      await audit(tx, principal, 'calendar.update', { type: 'calendar', id: calendar.id });
      return (await toCalendars(tx, [updated], [await requireAccess(tx, principal, updated.id, 'manage')]))[0]!;
    });
    return c.json(row, 200, { ETag: etagOf({ id: row.id, updatedAt: new Date(row.updatedAt!) }) });
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
    return c.json(row, 200, { ETag: etagOf({ id: row.id, updatedAt: new Date(row.updatedAt!) }) });
  });
