/** Calendar grants to a colleague or every current member of the tenant. */
import { createRoute, z } from '@hono/zod-openapi';
import { calendarAccount, calendarShare, member, sourceCalendar, user, withTenant, type CalendarShare, type AccountId, type SourceCalendarId, type TenantTx } from '@supercal/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Principal } from '../auth/principal.ts';
import { ACCESS_LEVELS, requireAccess, requireGrantChange, type Access } from '../hosted/access.ts';
import { audit, createApiApp, etagOf, ifMatchHeaders, NotFound, Problem, ProblemError, problemResponses, requireIfMatch, typeId } from './kit/index.ts';

const Grantee = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.string().min(1) }),
  z.object({ type: z.literal('tenant') }),
]).openapi('CalendarGrantee');
const Share = z.object({ id: typeId('shr'), grantee: Grantee, access: z.enum(ACCESS_LEVELS),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  createdBy: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), etag: z.string(),
}).openapi('CalendarShare');
const params = z.object({ id: typeId('cal') });
const shareParams = params.extend({ shareId: typeId('shr') });
const tags = ['Sharing'];
const path = '/api/v1/calendars/{id}/shares';
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true as const, content: { 'application/json': { schema } } });
const errors = problemResponses(400, 401, 403, 404, 409, 412, 422);
const list = createRoute({ method: 'get', path, operationId: 'listCalendarShares', tags, request: { params },
  responses: { 200: json('Grants, including colleague names and emails', z.object({ items: z.array(Share) })), ...errors } });
const create = createRoute({ method: 'post', path, operationId: 'createCalendarShare', tags,
  request: { params, body: body(z.object({ grantee: Grantee, access: z.enum(ACCESS_LEVELS) })) },
  responses: { 201: json('Created grant', Share), ...errors, 409: { description: 'Existing grant', content: { 'application/problem+json': { schema: Problem.extend({ id: typeId('shr') }) } } } } });
const update = createRoute({ method: 'patch', path: `${path}/{shareId}`, operationId: 'updateCalendarShare', tags,
  request: { params: shareParams, headers: ifMatchHeaders, body: body(z.object({ access: z.enum(ACCESS_LEVELS) })) },
  responses: { 200: json('Updated grant', Share), ...errors } });
const remove = createRoute({ method: 'delete', path: `${path}/{shareId}`, operationId: 'deleteCalendarShare', tags,
  request: { params: shareParams }, responses: { 204: { description: 'Revoked on the next request' }, ...errors } });

class ExistingShare extends ProblemError {
  constructor(readonly id: CalendarShare['id']) { super(409, 'A grant already exists for this grantee'); }
  override toProblem(instance: string) { return { ...super.toProblem(instance), id: this.id }; }
}

async function info(tx: TenantTx, row: CalendarShare): Promise<z.infer<typeof Share>> {
  const [grantee] = row.granteeUserId ? await tx.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, row.granteeUserId)) : [];
  return { id: row.id, grantee: row.granteeUserId ? { type: 'user', userId: row.granteeUserId } : { type: 'tenant' },
    access: row.access, user: grantee ?? null, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), etag: etagOf(row) };
}

/** Serializes grant changes, including duplicate checks and manager restrictions. */
async function managed(tx: TenantTx, principal: Principal, id: SourceCalendarId) {
  await tx.select({ id: sourceCalendar.id }).from(sourceCalendar).where(eq(sourceCalendar.id, id)).for('update');
  return requireAccess(tx, principal, id, 'manage');
}
async function grantable(tx: TenantTx, accountId: AccountId, access: Access) {
  const [account] = await tx.select({ provider: calendarAccount.provider }).from(calendarAccount).where(eq(calendarAccount.id, accountId));
  if (account?.provider !== 'hosted' && (access === 'write' || access === 'manage')) throw new ProblemError(422, 'Imported calendars support free-busy and read access', undefined, 'calendar-not-hosted');
}

export const shareRoutes = createApiApp()
  .openapi(list, async (c) => {
    const { principal } = c.var;
    const items = await withTenant(principal.tenantId, async (tx) => {
      await requireAccess(tx, principal, c.req.valid('param').id, 'manage');
      const rows = await tx.select({ share: calendarShare, user: { id: user.id, name: user.name, email: user.email } }).from(calendarShare)
        .leftJoin(user, eq(user.id, calendarShare.granteeUserId)).where(eq(calendarShare.calendarId, c.req.valid('param').id)).orderBy(asc(calendarShare.createdAt), asc(calendarShare.id));
      return rows.map(({ share, user: grantee }) => ({ id: share.id, grantee: share.granteeUserId ? { type: 'user' as const, userId: share.granteeUserId } : { type: 'tenant' as const },
        access: share.access, user: grantee, createdBy: share.createdBy, createdAt: share.createdAt.toISOString(), updatedAt: share.updatedAt.toISOString(), etag: etagOf(share) }));
    });
    return c.json({ items }, 200);
  })
  .openapi(create, async (c) => {
    const { principal } = c.var;
    const input = c.req.valid('json'), { id } = c.req.valid('param');
    const result = await withTenant(principal.tenantId, async (tx) => {
      const { calendar, access } = await managed(tx, principal, id);
      requireGrantChange(access, input.access);
      await grantable(tx, calendar.accountId, input.access);
      const granteeUserId = input.grantee.type === 'user' ? input.grantee.userId : null;
      if (granteeUserId) {
        const [membership] = await tx.select({ id: member.userId }).from(member).where(and(eq(member.organizationId, principal.tenantId), eq(member.userId, granteeUserId)));
        if (!membership) throw new NotFound('No such tenant member');
        const [owner] = await tx.select({ id: calendarAccount.ownerUserId }).from(calendarAccount).where(eq(calendarAccount.id, calendar.accountId));
        if (owner?.id === granteeUserId) throw new ProblemError(422, 'The owner already has full access');
      }
      const [existing] = await tx.select({ id: calendarShare.id }).from(calendarShare).where(and(eq(calendarShare.calendarId, id), granteeUserId ? eq(calendarShare.granteeUserId, granteeUserId) : isNull(calendarShare.granteeUserId)));
      if (existing) throw new ExistingShare(existing.id);
      const [row] = await tx.insert(calendarShare).values({ tenantId: principal.tenantId, calendarId: id, granteeUserId, access: input.access, createdBy: principal.userId }).returning();
      if (!row) throw new Error('Share insert failed');
      await audit(tx, principal, 'share.create', { type: 'calendar_share', id: row.id });
      return info(tx, row);
    });
    return c.json(result, 201, { ETag: result.etag });
  })
  .openapi(update, async (c) => {
    const { principal } = c.var;
    const { id, shareId } = c.req.valid('param'), input = c.req.valid('json');
    const result = await withTenant(principal.tenantId, async (tx) => {
      const { calendar, access } = await managed(tx, principal, id);
      const [before] = await tx.select().from(calendarShare).where(and(eq(calendarShare.id, shareId), eq(calendarShare.calendarId, id)));
      if (!before) throw new NotFound('No such share');
      requireGrantChange(access, before.access, input.access);
      await grantable(tx, calendar.accountId, input.access);
      requireIfMatch(c, etagOf(before));
      const [row] = await tx.update(calendarShare).set({ access: input.access, updatedAt: new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1)) }).where(eq(calendarShare.id, shareId)).returning();
      if (!row) throw new NotFound('No such share');
      await audit(tx, principal, 'share.update', { type: 'calendar_share', id: shareId });
      return info(tx, row);
    });
    return c.json(result, 200, { ETag: result.etag });
  })
  .openapi(remove, async (c) => {
    const { principal } = c.var;
    const { id, shareId } = c.req.valid('param');
    await withTenant(principal.tenantId, async (tx) => {
      const { access } = await managed(tx, principal, id);
      const [row] = await tx.select().from(calendarShare).where(and(eq(calendarShare.id, shareId), eq(calendarShare.calendarId, id)));
      if (!row) throw new NotFound('No such share');
      requireGrantChange(access, row.access);
      await tx.delete(calendarShare).where(eq(calendarShare.id, shareId));
      await audit(tx, principal, 'share.delete', { type: 'calendar_share', id: shareId });
    });
    return c.body(null, 204);
  });
