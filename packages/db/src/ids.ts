/**
 * TypeIDs: `<prefix>_<26 base32 chars>`, the suffix being a UUIDv7 in Crockford base32
 * (https://github.com/jetify-com/typeid). Branded per prefix so ids of different entities cannot mix.
 */
export const ID_PREFIXES = ['acc', 'cal', 'feed', 'pub', 'snk', 'tgt', 'key', 'aud', 'lnk'] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

export type Id<P extends IdPrefix> = string & { readonly __id: P };

export type AccountId = Id<'acc'>;
export type SourceCalendarId = Id<'cal'>;
export type FeedId = Id<'feed'>;
export type CalendarLinkId = Id<'lnk'>;
export type PublicationId = Id<'pub'>;
export type SinkId = Id<'snk'>;
export type SyncTargetId = Id<'tgt'>;
export type ApiKeyBindingId = Id<'key'>;
export type AuditId = Id<'aud'>;

/** A Better Auth organization id. Opaque text, so it is branded but not a TypeID. */
export type TenantId = string & { readonly __tenantId: true };

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SUFFIX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

function uuidv7(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
}

/** Creates a fresh, time-ordered id for `prefix`. */
export const newId = <P extends IdPrefix>(prefix: P): Id<P> => {
  let value = uuidv7();
  let suffix = '';
  for (let i = 0; i < 26; i++, value >>= 5n) suffix = ALPHABET[Number(value & 31n)] + suffix;
  return `${prefix}_${suffix}` as Id<P>;
};

/** Validates untrusted input (API paths, bodies) as an id of `prefix`; null when it is not one. */
export const parseId = <P extends IdPrefix>(prefix: P, raw: string): Id<P> | null => {
  const [head, suffix, ...rest] = raw.split('_');
  return head === prefix && suffix !== undefined && rest.length === 0 && SUFFIX.test(suffix) ? (raw as Id<P>) : null;
};

/** Accepts a Better Auth organization id read from a verified session or key binding. */
export const parseTenantId = (raw: string): TenantId | null => (raw.length > 0 ? (raw as TenantId) : null);
