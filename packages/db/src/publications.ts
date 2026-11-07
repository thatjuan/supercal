/**
 * Publication versioning (architecture §6). `epoch` is part of every sync token and object ETag, so
 * bumping it makes clients resync the collection; `config_version` only refreshes collection
 * properties and ICS ETags. `publicationChangeKind` decides which one an edit needs.
 */
import { eq, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import type { PublicationId } from './ids.ts';
import { publication, type Publication, type PublicationSource } from './schema/index.ts';
import type { TenantTx } from './tx.ts';

/** What decides a publication's output: its row (minus identity and versions) and its sources. */
export type PublicationConfig = Omit<Publication, 'id' | 'tenantId' | 'epoch' | 'configVersion'> & {
  sources: readonly Pick<PublicationSource, 'sourceCalendarId' | 'priority'>[];
};

export type PublicationChangeKind = 'epoch' | 'config' | 'none';

/**
 * Which version each field bumps. Only cosmetic collection properties are `config`; anything that
 * can change output UIDs or content is `epoch`. A new publication column fails to compile here
 * until it is classified.
 */
const FIELD_KIND = {
  name: 'config',
  color: 'config',
  sortOrder: 'config',
  feedId: 'epoch',
  kind: 'epoch',
  slug: 'epoch',
  privacy: 'epoch',
  filters: 'epoch',
  keepAlarms: 'epoch',
  enabled: 'epoch',
  sources: 'epoch',
} as const satisfies Record<keyof PublicationConfig, Exclude<PublicationChangeKind, 'none'>>;

const FIELDS = Object.keys(FIELD_KIND) as (keyof PublicationConfig)[];

const comparable = (config: PublicationConfig, field: keyof PublicationConfig) =>
  field === 'sources' ? [...config.sources].sort((a, b) => a.sourceCalendarId.localeCompare(b.sourceCalendarId)) : config[field];

/** The version bump an edit from `before` to `after` needs; call it on every publication update. */
export function publicationChangeKind(before: PublicationConfig, after: PublicationConfig): PublicationChangeKind {
  const changed = FIELDS.filter((field) => !isDeepStrictEqual(comparable(before, field), comparable(after, field)));
  if (changed.some((field) => FIELD_KIND[field] === 'epoch')) return 'epoch';
  return changed.length > 0 ? 'config' : 'none';
}

/** Invalidates every sync token and object ETag of the publication. Returns the new epoch. */
export const bumpEpoch = (tx: TenantTx, publicationId: PublicationId) => bump(tx, publicationId, 'epoch');

/** Refreshes collection properties (name, colour, order) without a resync. Returns the new config version. */
export const bumpConfigVersion = (tx: TenantTx, publicationId: PublicationId) => bump(tx, publicationId, 'configVersion');

async function bump(tx: TenantTx, publicationId: PublicationId, version: 'epoch' | 'configVersion'): Promise<number> {
  const column = publication[version];
  const [row] = await tx
    .update(publication)
    .set({ [version]: sql`${column} + 1` })
    .where(eq(publication.id, publicationId))
    .returning({ value: column });
  if (!row) throw new Error(`publication ${publicationId} not found`);
  return row.value;
}
