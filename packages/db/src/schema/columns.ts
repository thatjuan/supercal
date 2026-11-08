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

/** Postgres `tstzrange`, which Drizzle has no native column for. */
export const tstzrange = customType<{ data: Span; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: ({ start, end }) => `[${start.toISOString()},${end === 'infinity' ? end : end.toISOString()}${end !== 'infinity' && start.getTime() === end.getTime() ? ']' : ')'}`,
  fromDriver: (value) => {
    const match = RANGE.exec(value);
    const start = match?.[1] ?? match?.[2];
    const end = match?.[3] ?? match?.[4];
    if (!start || !end) throw new Error(`unsupported tstzrange ${value}`);
    return { start: new Date(start), end: end === 'infinity' ? end : new Date(end) };
  },
});
