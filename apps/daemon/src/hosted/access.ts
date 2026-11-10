/** Calendar authorization, shared by REST, streams and device CalDAV logins. */
import { calendarAccess, calendarAccount, calendarLink, calendarShare, member, sourceCalendar, type SourceCalendarId, type TenantTx } from '@supercal/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Forbidden, NotFound } from '../api/kit/problem.ts';
import { hasRole } from '../auth/policy.ts';
import type { Principal } from '../auth/principal.ts';

export const ACCESS_LEVELS = calendarAccess.enumValues;
export type Access = (typeof ACCESS_LEVELS)[number] | 'owner';
const levels = [...ACCESS_LEVELS, 'owner'] as const;

/** All capability checks compare this one ordered access scale. */
export function atLeast(access: Access | null, min: Access): access is Access {
  return access !== null && levels.indexOf(access) >= levels.indexOf(min);
}

/** Managers can delegate lower grants; only owners/admins may change any manage grant. */
export function requireGrantChange(actor: Access, ...grants: Access[]): void {
  if (grants.includes('manage') && !atLeast(actor, 'owner')) throw new Forbidden('Only owners and tenant admins can grant or remove manage access');
}

/** One query computes the highest grant, without multiplying calendars or querying per row. */
async function calendarsWithAccess(tx: TenantTx, principal: Principal, id?: SourceCalendarId) {
  const direct = alias(calendarShare, 'direct_share');
  const tenant = alias(calendarShare, 'tenant_share');
  const ordered = sql`array[${sql.join(ACCESS_LEVELS.map((level) => sql`${level}`), sql`, `)}]::text[]`;
  const owned = eq(calendarAccount.ownerUserId, principal.userId);
  const grant = sql<Access | null>`case
    when ${member.userId} is null then null
    else (${ordered})[greatest(
      array_position(${ordered}, ${direct.access}::text),
      array_position(${ordered}, ${tenant.access}::text))]
    end`;
  // Capability loss suspends editing without discarding the grant that a reconnect can restore.
  const effectiveGrant = sql<Access | null>`case when ${calendarAccount.provider} <> 'hosted'
    and coalesce((${sourceCalendar.capabilities}->>'write')::boolean, false) = false
    and ${grant} in ('write', 'manage') then 'read' else ${grant} end`;
  const access = sql<Access | null>`case when ${owned} or ${hasRole(principal, 'admin')} then 'owner' else ${effectiveGrant} end`;
  return tx.select({ calendar: sourceCalendar, access, owned, grant }).from(sourceCalendar)
    .innerJoin(calendarAccount, eq(calendarAccount.id, sourceCalendar.accountId))
    .leftJoin(member, and(eq(member.organizationId, sourceCalendar.tenantId), eq(member.userId, principal.userId)))
    .leftJoin(direct, and(eq(direct.calendarId, sourceCalendar.id), eq(direct.granteeUserId, principal.userId)))
    .leftJoin(tenant, and(eq(tenant.calendarId, sourceCalendar.id), isNull(tenant.granteeUserId)))
    .where(id === undefined ? undefined : eq(sourceCalendar.id, id))
    .orderBy(asc(sourceCalendar.accountId), asc(sourceCalendar.name), asc(sourceCalendar.id));
}

/** Highest usable access; imported editing grants become read access while provider writability is lost. */
export async function effectiveAccess(tx: TenantTx, principal: Principal, calendarId: SourceCalendarId): Promise<Access | null> {
  return (await calendarsWithAccess(tx, principal, calendarId))[0]?.access ?? null;
}

/** Missing from the tenant is 404; an insufficient grant is 403. */
export async function requireAccess(tx: TenantTx, principal: Principal, calendarId: SourceCalendarId, min: Access) {
  const [row] = await calendarsWithAccess(tx, principal, calendarId);
  if (!row) throw new NotFound('No such calendar');
  if (!atLeast(row.access, min)) throw new Forbidden(`Requires ${min} calendar access`);
  return { calendar: row.calendar, access: row.access };
}

/** Every visible calendar and its effective grant, in one query. */
export async function accessibleCalendars(tx: TenantTx, principal: Principal, min: Access) {
  return (await calendarsWithAccess(tx, principal)).flatMap(({ calendar, access }) => atLeast(access, min) && access ? [{ calendar, access }] : []);
}

/** Device homes require ownership or an actual readable grant, retaining effective admin rights. */
export async function deviceHomeCalendars(tx: TenantTx, principal: Principal) {
  return (await calendarsWithAccess(tx, principal)).flatMap(({ calendar, access, owned, grant }) =>
    (owned || atLeast(grant, 'read')) && atLeast(access, 'read') ? [{ calendar, access }] : []);
}

/**
 * Deletes published links whose creator can no longer manage the calendar: not its owner, and not a
 * current member who is a tenant owner or admin or holds a personal or tenant-wide manage grant.
 */
export async function pruneOrphanLinks(tx: TenantTx, calendarId?: SourceCalendarId): Promise<void> {
  await tx.execute(sql`delete from ${calendarLink}
    using ${sourceCalendar}, ${calendarAccount}
    where ${calendarLink.calendarId} = ${sourceCalendar.id}
      and ${sourceCalendar.accountId} = ${calendarAccount.id}
      ${calendarId === undefined ? sql`` : sql`and ${sourceCalendar.id} = ${calendarId}`}
      and ${calendarLink.createdBy} <> ${calendarAccount.ownerUserId}
      and not exists (
        select 1 from ${member}
        where ${member.organizationId} = ${calendarLink.tenantId}
          and ${member.userId} = ${calendarLink.createdBy}
          and (${member.role} in ('owner', 'admin') or exists (
            select 1 from ${calendarShare}
            where ${calendarShare.calendarId} = ${calendarLink.calendarId}
              and (${calendarShare.granteeUserId} = ${calendarLink.createdBy} or ${calendarShare.granteeUserId} is null)
              and ${calendarShare.access} = 'manage'
          ))
      )`);
}
