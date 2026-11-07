/**
 * Feed credentials (architecture §7). Each generator returns the secret, which is shown to the
 * user once, and what is stored: an argon2id hash for the CalDAV password, a sha256 hex digest
 * for the ICS token. Feed credentials never grant API access.
 */
import type { SecretBox, SecretContext } from '@supercal/db';

const HANDLE_MAX = 24;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** RFC 4648 base32, lowercase, without padding. */
function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    for (; bits >= 5; bits -= 5) out += BASE32[(value >>> (bits - 5)) & 31];
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** The handle a user's CalDAV usernames start with: their email's local part (or name) as `[a-z0-9-]`. */
export function ownerHandle(owner: { email: string; name: string }): string {
  const clean = (raw: string) =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, HANDLE_MAX)
      .replace(/^-+|-+$/g, '');
  return clean(owner.email.split('@')[0] ?? '') || clean(owner.name) || 'user';
}

/** `<handle>-<6 random [a-z0-9]>`. Only `[a-z0-9-]`, because Apple breaks on percent-encoded usernames. */
export function caldavUsername(handle: string): string {
  const suffix = [...randomBytes(6)].map((byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join('');
  return `${handle}-${suffix}`;
}

/** A CalDAV app password: 24 random bytes as lowercase base32. */
export async function newCaldavPassword(): Promise<{ password: string; hash: string }> {
  const password = base32(randomBytes(24));
  return { password, hash: await Bun.password.hash(password, { algorithm: 'argon2id' }) };
}

/** The stored form of an ICS token: its sha256 as hex. */
export const icsTokenHash = (token: string) => new Bun.CryptoHasher('sha256').update(token).digest('hex');

/** An ICS token: 32 random bytes as base64url. */
export function newIcsToken(): { token: string; hash: string } {
  const token = Buffer.from(randomBytes(32)).toString('base64url');
  return { token, hash: icsTokenHash(token) };
}

const uidSecretContext = (tenantId: SecretContext['tenantId'], feedId: string): SecretContext => ({
  tenantId,
  table: 'feed',
  recordId: feedId,
  field: 'uid_secret',
});

/** A fresh `feed.uid_secret`: 32 random bytes, encrypted for that feed row. */
export const newUidSecret = (secrets: SecretBox, feed: { tenantId: SecretContext['tenantId']; id: string }) =>
  secrets.encrypt(Buffer.from(randomBytes(32)).toString('base64url'), uidSecretContext(feed.tenantId, feed.id));

/** Decrypts a feed's `uid_secret` into the HMAC key projection uses for privacy UIDs. */
export async function openUidSecret(secrets: SecretBox, feed: { tenantId: SecretContext['tenantId']; id: string; uidSecret: string }) {
  const { plaintext } = await secrets.decrypt(feed.uidSecret, uidSecretContext(feed.tenantId, feed.id));
  return crypto.subtle.importKey('raw', Buffer.from(plaintext, 'base64url'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
