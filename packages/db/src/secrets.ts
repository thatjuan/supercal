/**
 * Secret box for values stored encrypted (provider credentials, feed UID secrets): envelope
 * AES-256-GCM with WebCrypto. Each value gets a random data key, wrapped by the active master key
 * from `SUPERCAL_KEYS=v2:base64,v1:base64` (first is active). Both layers authenticate the format,
 * key version and the record the value belongs to, so a ciphertext cannot be moved to another row.
 *
 * Stored format: `sc1.<ver>.<wrapIv>.<wrappedKey>.<dataIv>.<ciphertext>` (base64url parts).
 */
import type { z } from 'zod';
import type { TenantId } from './ids.ts';

/** Where a ciphertext lives. Decryption fails unless it matches the context used to encrypt. */
export type SecretContext = { tenantId: TenantId; table: string; recordId: string; field: string };

/**
 * `reencrypted` is set when the value used an older master key. Persist it with compare-and-swap
 * against the original ciphertext so a concurrent credential update is not overwritten.
 */
export type Opened<T> = { value: T; reencrypted?: string };

export type SecretBox = Awaited<ReturnType<typeof createSecretBox>>;

type Options = {
  /** `SUPERCAL_KEYS`. */
  keys?: string | undefined;
  /** `SUPERCAL_INSECURE_DEV`: without keys, use a fixed, public dev key. */
  insecureDev?: boolean;
  warn?: (message: string) => void;
};

const DEV_SEED = 'supercal insecure development key; never use in production';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url ciphertext');
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

async function parseKeys({ keys = '', insecureDev = false, warn = console.warn }: Options) {
  if (keys === '' && insecureDev) {
    warn('SUPERCAL_INSECURE_DEV=1 and SUPERCAL_KEYS is unset: secrets are encrypted with a fixed, PUBLIC development key. Never run this in production.');
    return [{ version: 'dev', raw: new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(DEV_SEED))) }];
  }
  return keys.split(',').map((entry) => {
    const match = /^([A-Za-z0-9_-]+):([A-Za-z0-9+/]+={0,2})$/.exec(entry.trim());
    if (!match?.[1] || !match[2]) throw new Error('SUPERCAL_KEYS must be version:base64 entries');
    const raw = new Uint8Array(Buffer.from(match[2], 'base64'));
    if (raw.length !== 32) throw new Error('Master keys must be 32 bytes');
    return { version: match[1], raw };
  });
}

/** Builds a secret box from the key ring. Throws on a malformed, empty or duplicate-version ring. */
export async function createSecretBox(options: Options = {}) {
  const entries = await parseKeys(options);
  const [active] = entries;
  if (!active) throw new Error('No active master key');
  const activeVersion = active.version;
  if (new Set(entries.map((e) => e.version)).size !== entries.length) throw new Error('Duplicate key version');
  const keys = new Map(
    await Promise.all(
      entries.map(async ({ version, raw }) => [version, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])] as const),
    ),
  );

  const aad = (version: string, { tenantId, table, recordId, field }: SecretContext) =>
    encoder.encode(JSON.stringify(['supercal', 'sc1', version, tenantId, table, recordId, field]));

  /** Encrypts `plaintext` with the active master key. Output is randomised. */
  async function encrypt(plaintext: string, context: SecretContext): Promise<string> {
    const master = keys.get(activeVersion);
    if (!master) throw new Error('Missing active master key');
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const dataKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = aad(activeVersion, context);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, dataKey, encoder.encode(plaintext)));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData }, master, rawKey));
    rawKey.fill(0);
    return ['sc1', activeVersion, encode(wrapIv), encode(wrapped), encode(iv), encode(data)].join('.');
  }

  /** Decrypts and authenticates `ciphertext`; throws on tampering, a wrong context or an unknown key. */
  async function decrypt(ciphertext: string, context: SecretContext): Promise<{ plaintext: string; reencrypted?: string }> {
    const [format, version, wrapIv, wrapped, iv, data, ...extra] = ciphertext.split('.');
    if (format !== 'sc1' || !version || !wrapIv || !wrapped || !iv || !data || extra.length) throw new Error('Invalid ciphertext format');
    const master = keys.get(version);
    if (!master) throw new Error(`Unknown master key version ${version}`);
    const additionalData = aad(version, context);
    const rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(wrapIv), additionalData }, master, decode(wrapped)));
    const dataKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    rawKey.fill(0);
    const plaintext = decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData }, dataKey, decode(data)));
    return version === activeVersion ? { plaintext } : { plaintext, reencrypted: await encrypt(plaintext, context) };
  }

  /** Validates `value` with `schema`, then encrypts it as JSON. */
  async function encryptJson<T>(schema: z.ZodType<T>, value: T, context: SecretContext): Promise<string> {
    return encrypt(JSON.stringify(schema.parse(value)), context);
  }

  /** Decrypts JSON written by `encryptJson` and parses it with `schema`. */
  async function decryptJson<T>(schema: z.ZodType<T>, ciphertext: string, context: SecretContext): Promise<Opened<T>> {
    const { plaintext, ...rest } = await decrypt(ciphertext, context);
    return { value: schema.parse(JSON.parse(plaintext)), ...rest };
  }

  return { encrypt, decrypt, encryptJson, decryptJson, activeVersion };
}
