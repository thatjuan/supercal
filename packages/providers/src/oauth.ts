/**
 * OAuth 2.0 token-endpoint calls (RFC 6749 §4.1.3, §6), shared by the OAuth providers: the daemon
 * exchanges authorization codes with them and the adapters refresh access tokens.
 *
 *   const token = await tokenRequest(GOOGLE_TOKEN_URL, { grant_type: 'refresh_token', … }, signal);
 */
import { z } from 'zod';
import { ProviderUnavailableError } from './adapter.ts';

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const ErrorResponse = z.object({ error: z.string(), error_description: z.string().optional() });

/** The token endpoint refused the request; `code` is the RFC 6749 error code, e.g. `invalid_grant`. */
export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  constructor(
    readonly code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

/** POSTs a form to a token endpoint. Throws `OAuthError` for a 4xx and `ProviderUnavailableError` for anything transient. */
export async function tokenRequest(url: string, params: Record<string, string>, signal: AbortSignal): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
    signal,
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return TokenResponse.parse(body);
  if (res.status >= 500 || res.status === 429) throw new ProviderUnavailableError(`token endpoint answered ${res.status}`);
  const error = ErrorResponse.safeParse(body);
  throw error.success ? new OAuthError(error.data.error, error.data.error_description) : new OAuthError(`http_${res.status}`);
}

/** The claims of an ID token received directly from the token endpoint over TLS, where OIDC allows skipping the signature check. Validate them with a schema. */
export function idTokenClaims(idToken: string): unknown {
  const payload = idToken.split('.')[1];
  if (!payload) throw new OAuthError('invalid_id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
