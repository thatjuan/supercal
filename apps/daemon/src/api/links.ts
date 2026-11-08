/** Published links: independent, view-only bearer URLs for one owned calendar. */
import { createRoute, z } from '@hono/zod-openapi';
import { calendarLink, newId, privacy, sourceCalendar, withTenant, type CalendarLink, type SecretBox, type SourceCalendarId, type TenantTx } from '@supercal/db';
import { and, asc, count, eq } from 'drizzle-orm';
import { requireAccess } from '../hosted/access.ts';
import type { Principal } from '../auth/principal.ts';
import { newIcsToken, newUidSecret } from '../feeds/credentials.ts';
import { audit, createApiApp, NotFound, ProblemError, problemResponses, typeId } from './kit/index.ts';
import { calendarSubscribeLinks, SubscribeLinks } from './subscribe.ts';

export const CalendarLinkInfo = z.object({
  id: typeId('lnk'),
  name: z.string().nullable(),
  privacy: z.enum(privacy.enumValues),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
}).openapi('CalendarLink');
export const CreatedCalendarLink = CalendarLinkInfo.extend({
  token: z.string(),
  url: z.url(),
  webcalUrl: z.url(),
  subscribe: SubscribeLinks,
}).openapi('CreatedCalendarLink');

const params = z.object({ id: typeId('cal') });
const linkParams = params.extend({ linkId: typeId('lnk') });
const settings = {
  name: z.string().min(1).max(100).nullable().optional(),
  expiresAt: z.iso.datetime().refine((value) => Date.parse(value) > Date.now(), 'Must be in the future').nullable().optional(),
};
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true as const, content: { 'application/json': { schema } } });
const tags = ['Published links'];
const path = '/api/v1/calendars/{id}/links';
const listLinks = createRoute({
  method: 'get', path, operationId: 'listCalendarLinks', tags, request: { params },
  responses: { 200: json('Published links, without secrets', z.object({ items: z.array(CalendarLinkInfo) })), ...problemResponses(400, 401, 403, 404) },
});
const createLink = createRoute({
  method: 'post', path, operationId: 'createCalendarLink', tags,
  request: { params, body: body(z.strictObject({ ...settings, privacy: z.enum(privacy.enumValues) })) },
  responses: { 201: json('Created link; the token is shown only once', CreatedCalendarLink), ...problemResponses(400, 401, 403, 404, 409) },
});
const updateLink = createRoute({
  method: 'patch', path: `${path}/{linkId}`, operationId: 'updateCalendarLink', tags,
  request: { params: linkParams, body: body(z.strictObject(settings)) },
  responses: { 200: json('Updated link; privacy is immutable', CalendarLinkInfo), ...problemResponses(400, 401, 403, 404) },
});
const deleteLink = createRoute({
  method: 'delete', path: `${path}/{linkId}`, operationId: 'deleteCalendarLink', tags, request: { params: linkParams },
  responses: { 204: { description: 'Revoked immediately' }, ...problemResponses(400, 401, 403, 404) },
});

function toInfo(row: CalendarLink): z.infer<typeof CalendarLinkInfo> {
  return { id: row.id, name: row.name, privacy: row.privacy, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

/** Locks the calendar so concurrent link creations cannot exceed its quota. RLS hides other tenants. */
async function managedCalendar(tx: TenantTx, principal: Principal, id: SourceCalendarId) {
  await tx.select({ id: sourceCalendar.id }).from(sourceCalendar).where(eq(sourceCalendar.id, id)).for('update');
  return (await requireAccess(tx, principal, id, 'manage')).calendar;
}

export function linkRoutes(secrets: SecretBox) {
  return createApiApp()
    .openapi(listLinks, async (c) => {
      const { principal } = c.var;
      const { id } = c.req.valid('param');
      const items = await withTenant(principal.tenantId, async (tx) => {
        await managedCalendar(tx, principal, id);
        return (await tx.select().from(calendarLink).where(eq(calendarLink.calendarId, id)).orderBy(asc(calendarLink.createdAt), asc(calendarLink.id))).map(toInfo);
      });
      return c.json({ items }, 200);
    })
    .openapi(createLink, async (c) => {
      const { principal } = c.var;
      const { id: calendarId } = c.req.valid('param');
      const input = c.req.valid('json');
      const { token, hash } = newIcsToken();
      const { row, calendar } = await withTenant(principal.tenantId, async (tx) => {
        const calendar = await managedCalendar(tx, principal, calendarId);
        const [total] = await tx.select({ count: count() }).from(calendarLink).where(eq(calendarLink.calendarId, calendarId));
        if ((total?.count ?? 0) >= 20) throw new ProblemError(409, 'A calendar can have at most 20 published links', undefined, 'link-quota');
        const id = newId('lnk');
        const [row] = await tx.insert(calendarLink).values({
          id, tenantId: principal.tenantId, calendarId, name: input.name ?? null, privacy: input.privacy, tokenHash: hash,
          uidSecret: await newUidSecret(secrets, { tenantId: principal.tenantId, id }, 'calendar_link'),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: principal.userId,
        }).returning();
        if (!row) throw new Error('Link insert failed');
        await audit(tx, principal, 'link.create', { type: 'calendar_link', id });
        return { row, calendar };
      });
      const url = `${c.var.auth.publicUrl.replace(/\/$/, '')}/ics/l/${token}.ics`;
      return c.json({ ...toInfo(row), token, url, webcalUrl: url.replace(/^https?:/, 'webcal:'), subscribe: calendarSubscribeLinks(url, calendar.name) }, 201);
    })
    .openapi(updateLink, async (c) => {
      const { principal } = c.var;
      const { id, linkId } = c.req.valid('param');
      const input = c.req.valid('json');
      const row = await withTenant(principal.tenantId, async (tx) => {
        await managedCalendar(tx, principal, id);
        const [before] = await tx.select().from(calendarLink).where(and(eq(calendarLink.id, linkId), eq(calendarLink.calendarId, id)));
        if (!before) throw new NotFound('No such link');
        const [row] = await tx.update(calendarLink).set({
          name: input.name === undefined ? before.name : input.name,
          expiresAt: input.expiresAt === undefined ? before.expiresAt : input.expiresAt === null ? null : new Date(input.expiresAt),
        }).where(eq(calendarLink.id, linkId)).returning();
        if (!row) throw new NotFound('No such link');
        await audit(tx, principal, 'link.update', { type: 'calendar_link', id: linkId });
        return row;
      });
      return c.json(toInfo(row), 200);
    })
    .openapi(deleteLink, async (c) => {
      const { principal } = c.var;
      const { id, linkId } = c.req.valid('param');
      await withTenant(principal.tenantId, async (tx) => {
        await managedCalendar(tx, principal, id);
        const [row] = await tx.delete(calendarLink).where(and(eq(calendarLink.id, linkId), eq(calendarLink.calendarId, id))).returning({ id: calendarLink.id });
        if (!row) throw new NotFound('No such link');
        await audit(tx, principal, 'link.delete', { type: 'calendar_link', id: linkId });
      });
      return c.body(null, 204);
    });
}
