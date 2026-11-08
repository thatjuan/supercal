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

export const ProviderCredentials = z.discriminatedUnion('provider', [IcsCredentials, CaldavCredentials, IcloudCredentials]);
export type ProviderCredentials = z.infer<typeof ProviderCredentials>;
