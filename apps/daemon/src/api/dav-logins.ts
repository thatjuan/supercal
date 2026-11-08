import { createRoute, z } from '@hono/zod-openapi';
import { davLogin, user, withTenant } from '@supercal/db';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { canManageOwned } from '../auth/policy.ts';
import { notifyDavLoginRevoked } from '../bus.ts';
import { davUsername, newCaldavPassword, ownerHandle } from '../feeds/credentials.ts';
import { audit, createApiApp, Forbidden, NotFound, ProblemError, problemResponses, typeId } from './kit/index.ts';

const Login = z.object({ id: typeId('dvl'), name: z.string(), username: z.string(), lastUsedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime() }).openapi('DavLogin');
const Created = Login.omit({ lastUsedAt: true }).extend({ password: z.string(), serverUrl: z.url() }).openapi('CreatedDavLogin');
const json = <T extends z.ZodType>(description: string, schema: T) => ({ description, content: { 'application/json': { schema } } });
const tags = ['DAV logins'];
const list = createRoute({ method: 'get', path: '/api/v1/dav-logins', operationId: 'listDavLogins', tags,
  responses: { 200: json('Your device logins, without secrets', z.object({ items: z.array(Login) })), ...problemResponses(401, 403) } });
const create = createRoute({ method: 'post', path: '/api/v1/dav-logins', operationId: 'createDavLogin', tags,
  request: { body: { required: true, content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(100) }) } } } },
  responses: { 201: json('Created login; the password is shown only here', Created), ...problemResponses(400, 401, 403, 409) } });
const remove = createRoute({ method: 'delete', path: '/api/v1/dav-logins/{id}', operationId: 'deleteDavLogin', tags,
  request: { params: z.object({ id: typeId('dvl') }) },
  responses: { 204: { description: 'Revoked immediately' }, ...problemResponses(400, 401, 403, 404) } });

export const davLoginRoutes = createApiApp()
  .openapi(list, async (c) => {
    const { principal } = c.var;
    const items = await withTenant(principal.tenantId, (tx) => tx.select({ id: davLogin.id, name: davLogin.name, username: davLogin.username, lastUsedAt: davLogin.lastUsedAt, createdAt: davLogin.createdAt })
      .from(davLogin).where(eq(davLogin.userId, principal.userId)).orderBy(asc(davLogin.createdAt), asc(davLogin.id)));
    return c.json({ items: items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null })) }, 200);
  })
  .openapi(create, async (c) => {
    const { principal } = c.var;
    const credential = await newCaldavPassword();
    const row = await withTenant(principal.tenantId, async (tx) => {
      // Serialize the per-user quota even when two devices are enrolled concurrently.
      await tx.execute(sql`select pg_advisory_xact_lock(1937011300, hashtext(${principal.userId}))`);
      const [total] = await tx.select({ count: count() }).from(davLogin).where(eq(davLogin.userId, principal.userId));
      if ((total?.count ?? 0) >= 20) throw new ProblemError(409, 'DAV login quota exceeded', undefined, 'dav-login-quota');
      const [owner] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, principal.userId));
      if (!owner) throw new NotFound('No such user');
      const [login] = await tx.insert(davLogin).values({ tenantId: principal.tenantId, userId: principal.userId, name: c.req.valid('json').name,
        username: davUsername(ownerHandle(owner)), passwordHash: credential.hash }).returning();
      if (!login) throw new Error('DAV login insert returned no row');
      await audit(tx, principal, 'dav-login.create', { type: 'dav-login', id: login.id });
      return login;
    });
    return c.json({ id: row.id, name: row.name, username: row.username, password: credential.password, serverUrl: `${c.var.auth.publicUrl.replace(/\/$/, '')}/dav/`, createdAt: row.createdAt.toISOString() }, 201);
  })
  .openapi(remove, async (c) => {
    const { principal } = c.var;
    await withTenant(principal.tenantId, async (tx) => {
      const { id } = c.req.valid('param');
      const [row] = await tx.select().from(davLogin).where(eq(davLogin.id, id));
      if (!row) throw new NotFound('No such DAV login');
      if (!canManageOwned(principal, row.userId)) throw new Forbidden('You can only revoke your own DAV logins');
      await tx.delete(davLogin).where(and(eq(davLogin.id, id), eq(davLogin.userId, row.userId)));
      await audit(tx, principal, 'dav-login.delete', { type: 'dav-login', id });
      await notifyDavLoginRevoked(tx, id);
    });
    return c.body(null, 204);
  });
