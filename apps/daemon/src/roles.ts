import { z } from 'zod';

export const ROLES = ['api', 'dav', 'worker'] as const;

export type Role = (typeof ROLES)[number];

/** Parses a comma list such as `api,dav` (SUPERCAL_ROLES) into a set of known roles. */
export const rolesSchema = z
  .string()
  .transform((list) => list.split(',').map((role) => role.trim()).filter(Boolean))
  .pipe(z.array(z.enum(ROLES, { error: `must list only ${ROLES.join(', ')}` })).min(1, 'must name at least one role'))
  .transform((roles): ReadonlySet<Role> => new Set(roles));
