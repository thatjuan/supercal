/**
 * Provider credentials, stored as a secret-box ciphertext in `calendar_account.credentials`
 * (context `{tenantId, table: 'calendar_account', recordId, field: 'credentials'}`). Each provider
 * adds its variant to the union; the daemon decrypts and parses with `ProviderCredentials`.
 */
import { z } from 'zod';

/** An ICS/webcal subscription. The URL is a bearer secret, so it lives only here. */
const IcsCredentials = z.object({ provider: z.literal('ics'), url: z.url() });

export const ProviderCredentials = z.discriminatedUnion('provider', [IcsCredentials]);
export type ProviderCredentials = z.infer<typeof ProviderCredentials>;
