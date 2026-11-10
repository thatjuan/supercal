/**
 * Provider credentials, stored as a secret-box ciphertext in `calendar_account.credentials`
 * (context `{tenantId, table: 'calendar_account', recordId, field: 'credentials'}`). Each provider
 * adds its variant to the union; the daemon decrypts and parses with `ProviderCredentials`.
 */
import { z } from 'zod';

/** An ICS/webcal subscription. The URL is a bearer secret, so it lives only here. */
const IcsCredentials = z.object({ provider: z.literal('ics'), url: z.url() });

/** A generic CalDAV server, Basic auth. */
const CaldavCredentials = z.object({ provider: z.literal('caldav'), serverUrl: z.url({ protocol: /^https?$/ }), username: z.string(), password: z.string() });

/** iCloud: an Apple ID and an app-specific password. */
const IcloudCredentials = z.object({ provider: z.literal('icloud'), appleId: z.string(), appSpecificPassword: z.string() });

/** A Google account connected through OAuth. `sub` is the stable Google identity (`provider_subject`). */
const GoogleCredentials = z.object({
  provider: z.literal('google'),
  sub: z.string(),
  email: z.string(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
  scopes: z.array(z.string()),
});
export type GoogleCredentials = z.infer<typeof GoogleCredentials>;

/**
 * A Microsoft 365 or Outlook.com account connected through OAuth. `subject` is `${tid}:${oid}` from
 * the ID token (`provider_subject`). Refresh tokens rotate, so every refresh saves the new one.
 */
const MicrosoftCredentials = z.object({
  provider: z.literal('microsoft'),
  /** Missing on connections made before incremental editing consent was supported. */
  scopes: z.array(z.string()).optional(),
  subject: z.string(),
  email: z.string(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
});
export type MicrosoftCredentials = z.infer<typeof MicrosoftCredentials>;

export const ProviderCredentials = z.discriminatedUnion('provider', [IcsCredentials, CaldavCredentials, IcloudCredentials, GoogleCredentials, MicrosoftCredentials]);
export type ProviderCredentials = z.infer<typeof ProviderCredentials>;
