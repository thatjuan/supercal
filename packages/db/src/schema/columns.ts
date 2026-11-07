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

/** A time span; `end: null` is unbounded (an endless RRULE). Bounds are `[start, end)`. */
export type Span = { start: Date; end: Date | null };

const RANGE = /^\[(?:"([^"]+)"|([^,]+)),(?:"([^"]+)"|([^)]+))\)$/;

/** Postgres `tstzrange`, which Drizzle has no native column for. */
export const tstzrange = customType<{ data: Span; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: ({ start, end }) => `[${start.toISOString()},${end?.toISOString() ?? 'infinity'})`,
  fromDriver: (value) => {
    const match = RANGE.exec(value);
    const start = match?.[1] ?? match?.[2];
    const end = match?.[3] ?? match?.[4];
    if (!start || !end) throw new Error(`unsupported tstzrange ${value}`);
    return { start: new Date(start), end: end === 'infinity' ? null : new Date(end) };
  },
});
