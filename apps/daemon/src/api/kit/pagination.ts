/**
 * Cursor pagination over a `(created_at, id)` keyset, newest first. A list route validates
 * `pageQuery`, selects `cursorAt: cursorAt(col)` alongside its columns, filters with `keysetWhere`,
 * orders by `keysetOrder`, fetches `limit + 1` rows and hands them to `toPage`.
 */
import { z } from '@hono/zod-openapi';
import { desc, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { BadRequest } from './problem.ts';

export const pageQuery = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from a previous page’s `nextCursor`' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The page envelope for `item`. Name it with `.openapi('<Item>Page')`. */
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const Cursor = z.object({ v: z.literal(1), createdAt: z.iso.datetime(), id: z.string().min(1) });
export type Cursor = Omit<z.infer<typeof Cursor>, 'v'>;

/** `createdAt` keeps Postgres' microseconds (see `cursorAt`), so ties within a millisecond stay ordered. */
export const encodeCursor = ({ createdAt, id }: Cursor) =>
  Buffer.from(JSON.stringify({ v: 1, createdAt, id })).toString('base64url');

/** Parses a client cursor; anything tampered, truncated or of another version is a 400. */
export function decodeCursor(raw: string): Cursor {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    json = undefined;
  }
  const parsed = Cursor.safeParse(json);
  if (!parsed.success) throw new BadRequest([{ path: 'cursor', message: 'Invalid cursor' }]);
  return { createdAt: parsed.data.createdAt, id: parsed.data.id };
}

export type KeysetColumns = { createdAt: PgColumn; id: PgColumn };

/** A timestamp as RFC 3339 UTC text with microseconds; a JS `Date` would truncate them. */
export const cursorAt = (column: PgColumn) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Rows strictly after `cursor` in newest-first order; undefined (no filter) for the first page. */
export const keysetWhere = ({ createdAt, id }: KeysetColumns, cursor: Cursor | undefined): SQL | undefined =>
  cursor ? sql`(${createdAt}, ${id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})` : undefined;

export const keysetOrder = ({ createdAt, id }: KeysetColumns) => [desc(createdAt), desc(id)];

/** Trims a `limit + 1` result to `limit` items and derives `nextCursor` from the last one kept. */
export function toPage<T extends { id: string; cursorAt: string }>(rows: T[], limit: number) {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return {
    items: kept.map(({ cursorAt: _, ...item }) => item),
    nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.cursorAt, id: last.id }) : null,
  };
}
