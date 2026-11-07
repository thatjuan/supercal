/**
 * ETags for mutable resources. GET and PATCH responses set `ETag: etagOf(row)`; PATCH routes add
 * `ifMatchHeaders` to `request.headers` (an optional header in the spec and generated client) and
 * call `requireIfMatch` before writing.
 */
import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PreconditionFailed, PreconditionRequired } from './problem.ts';

export const ifMatchHeaders = z.object({
  'if-match': z.string().optional().openapi({ description: 'ETag from a previous read; 412 when it is stale' }),
});

/** Weak ETag over the row's identity and last update. */
export const etagOf = (row: { id: string; updatedAt: Date }) => `W/"${row.id}.${row.updatedAt.getTime()}"`;

const opaque = (tag: string) => tag.trim().replace(/^W\//, '');

/**
 * Throws 412 when `If-Match` is present and names neither `current` nor `*`, and 428 when it is
 * absent but `required`. Tags compare weakly (the `W/` prefix is ignored): our ETags are all weak.
 */
export function requireIfMatch(c: Context, current: string, { required = false } = {}): void {
  const header = c.req.header('if-match');
  if (header === undefined) {
    if (required) throw new PreconditionRequired();
    return;
  }
  const tags = header.split(',').map(opaque);
  if (!tags.includes('*') && !tags.includes(opaque(current))) throw new PreconditionFailed();
}
