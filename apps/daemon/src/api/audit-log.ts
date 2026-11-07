/** `GET /api/v1/audit-log`: the current tenant's audit entries, newest first (admin and owner). */
import { createRoute, z } from '@hono/zod-openapi';
import { auditLog, withTenant } from '@supercal/db';
import { and, eq, getTableColumns } from 'drizzle-orm';
import {
  AuditActor,
  createApiApp,
  cursorAt,
  decodeCursor,
  keysetOrder,
  keysetWhere,
  page,
  pageQuery,
  problemResponses,
  requireRole,
  toPage,
} from './kit/index.ts';

const AuditEntry = z
  .object({
    id: z.string(),
    actor: AuditActor,
    action: z.string(),
    targetType: z.string(),
    targetId: z.string().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
    at: z.iso.datetime(),
  })
  .openapi('AuditEntry');

const keyset = { createdAt: auditLog.at, id: auditLog.id };
const { tenantId: _, ...columns } = getTableColumns(auditLog);

const listAuditLog = createRoute({
  method: 'get',
  path: '/api/v1/audit-log',
  operationId: 'listAuditLog',
  tags: ['Audit log'],
  middleware: [requireRole('admin')] as const,
  request: { query: pageQuery.extend({ targetType: z.string().optional(), targetId: z.string().optional() }) },
  responses: {
    200: { description: 'A page of audit entries, newest first', content: { 'application/json': { schema: page(AuditEntry).openapi('AuditEntryPage') } } },
    ...problemResponses(400, 401, 403),
  },
});

export const auditLogRoutes = createApiApp().openapi(listAuditLog, async (c) => {
  const { cursor, limit, targetType, targetId } = c.req.valid('query');
  const after = cursor === undefined ? undefined : decodeCursor(cursor);
  const rows = await withTenant(c.var.principal.tenantId, (tx) =>
    tx
      .select({ ...columns, cursorAt: cursorAt(auditLog.at) })
      .from(auditLog)
      .where(
        and(
          keysetWhere(keyset, after),
          targetType === undefined ? undefined : eq(auditLog.targetType, targetType),
          targetId === undefined ? undefined : eq(auditLog.targetId, targetId),
        ),
      )
      .orderBy(...keysetOrder(keyset))
      .limit(limit + 1),
  );
  const { items, nextCursor } = toPage(rows, limit);
  return c.json({ items: items.map((row) => AuditEntry.parse({ ...row, at: row.at.toISOString() })), nextCursor }, 200);
});

