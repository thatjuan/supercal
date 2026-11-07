import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { TenantId } from './ids.ts';
import { createSecretBox, type SecretContext } from './secrets.ts';

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const context = (recordId = 'acc_1'): SecretContext => ({ tenantId: 'org_a' as TenantId, table: 'calendar_account', recordId, field: 'credentials' });

test('envelope round trip, Unicode, empty payload, random ciphertext', async () => {
  const box = await createSecretBox({ keys: `v1:${key()}` });
  for (const plaintext of ['', 'token-secret-ñ-📅']) {
    const a = await box.encrypt(plaintext, context());
    const b = await box.encrypt(plaintext, context());
    expect(a).not.toEqual(b);
    expect(await box.decrypt(a, context())).toEqual({ plaintext });
  }
});

test('context and ciphertext authentication reject swaps and tampering', async () => {
  const box = await createSecretBox({ keys: `v1:${key()}` });
  const encrypted = await box.encrypt('secret', context());
  await expect(box.decrypt(encrypted, context('acc_2'))).rejects.toThrow();
  await expect(box.decrypt(encrypted, { ...context(), field: 'uid_secret' })).rejects.toThrow();
  const parts = encrypted.split('.');
  const data = parts[5] ?? '';
  parts[5] = (data.startsWith('A') ? 'B' : 'A') + data.slice(1);
  await expect(box.decrypt(parts.join('.'), context())).rejects.toThrow();
});

test('lazy master-key rotation and retiring the old key', async () => {
  const v1 = key();
  const v2 = key();
  const encrypted = await (await createSecretBox({ keys: `v1:${v1}` })).encrypt('provider-refresh-token', context());
  const opened = await (await createSecretBox({ keys: `v2:${v2},v1:${v1}` })).decrypt(encrypted, context());
  expect(opened.plaintext).toBe('provider-refresh-token');
  expect(opened.reencrypted).toStartWith('sc1.v2.');
  const retired = await createSecretBox({ keys: `v2:${v2}` });
  await expect(retired.decrypt(encrypted, context())).rejects.toThrow('Unknown master key');
  expect(await retired.decrypt(opened.reencrypted ?? '', context())).toEqual({ plaintext: 'provider-refresh-token' });
});

test('reject malformed key rings', async () => {
  for (const keys of ['', `v1:${key()},v1:${key()}`, 'v1:AAAA', 'v1:not base64']) await expect(createSecretBox({ keys })).rejects.toThrow();
});

test('JSON helpers round-trip typed values and validate both ways', async () => {
  const credentials = z.object({ refreshToken: z.string(), scopes: z.array(z.string()) });
  const box = await createSecretBox({ keys: `v1:${key()}` });
  const value = { refreshToken: 'r-1', scopes: ['calendar'] };
  const encrypted = await box.encryptJson(credentials, value, context());
  expect(await box.decryptJson(credentials, encrypted, context())).toEqual({ value });
  await expect(box.decryptJson(z.object({ password: z.string() }), encrypted, context())).rejects.toThrow();
});

test('insecure dev mode uses a stable dev key and warns', async () => {
  const warnings: string[] = [];
  const options = { insecureDev: true, warn: (message: string) => warnings.push(message) };
  const encrypted = await (await createSecretBox(options)).encrypt('dev', context());
  expect(encrypted).toStartWith('sc1.dev.');
  expect(await (await createSecretBox(options)).decrypt(encrypted, context())).toEqual({ plaintext: 'dev' });
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain('PUBLIC development key');
});
