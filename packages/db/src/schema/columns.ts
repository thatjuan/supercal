import { customType, text } from 'drizzle-orm/pg-core';
import { newId, type Id, type IdPrefix, type TenantId } from '../ids.ts';
import { organization } from './auth.ts';

/** `tenant_id`, required on every tenant table and checked by the RLS policy. */
export const tenantId = () =>
  text('tenant_id')
    .$type<TenantId>()
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

/** A TypeID primary key, generated on insert when omitted. */
export const idColumn = <P extends IdPrefix>(prefix: P) =>
  text('id')
    .$type<Id<P>>()
    .primaryKey()
    .$defaultFn(() => newId(prefix));

/** A time span; `end: 'infinity'` is unbounded (an endless RRULE), as in `@supercal/core`. Bounds are `[start, end)`; a zero-duration event is the closed point `[start, start]`. */
export type Span = { start: Date; end: Date | 'infinity' };

const RANGE = /^\[(?:"([^"]+)"|([^,]+)),(?:"([^"]+)"|([^\]\)]+))[\]\)]$/;

/**
 * Postgres `tstzrange`, which Drizzle has no native column for. `empty` reads as null: builds before
 * 2026-11-08 stored a zero-duration span as `[t,t)`, which Postgres keeps as `empty`, losing `t`.
 * The no-op check in `recordChanges` treats a null span as changed, so re-normalising rewrites it.
 */
export const tstzrange = customType<{ data: Span | null; driverData: string | null }>({
  dataType: () => 'tstzrange',
  toDriver: (span) =>
    span && `[${span.start.toISOString()},${span.end === 'infinity' ? span.end : span.end.toISOString()}${span.end !== 'infinity' && span.start.getTime() === span.end.getTime() ? ']' : ')'}`,
  fromDriver: (value) => {
    if (value === null || value === 'empty') return null;
    const match = RANGE.exec(value);
    const start = match?.[1] ?? match?.[2];
    const end = match?.[3] ?? match?.[4];
    if (!start || !end) throw new Error(`unsupported tstzrange ${value}`);
    return { start: new Date(start), end: end === 'infinity' ? end : new Date(end) };
  },
});
