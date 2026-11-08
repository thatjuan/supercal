/**
 * Provider-independent parts of the OAuth authorization-code flow with PKCE (RFC 6749, RFC 7636),
 * shared by the Google and Microsoft account flows:
 *
 * - `state` is a signed token (HMAC-SHA256) valid for 10 minutes, holding the principal, the
 *   pending flow's id and the `returnTo` URL.
 * - The PKCE verifier stays server-side in `oauth_flow`, which the callback takes (deletes) once.
 * - `returnTo` must be on the public URL (or `WEB_ORIGIN` in development).
 *
 *   start:    const { flowId, challenge } = await beginFlow(tx, …); const state = oauth.state.sign({ …, flowId });
 *   callback: const state = oauth.state.verify(query.state); const verifier = await takeFlow(tx, state);
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { accountProvider, oauthFlow, parseTenantId, type AccountProvider, type TenantId, type TenantTx } from '@supercal/db';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

const STATE_TTL_MS = 10 * 60_000;

/** What the OAuth routes run on, set as `c.var.oauth`. A provider without credentials is null. */
export type OAuthDeps = {
  /** `SUPERCAL_PUBLIC_URL`: redirect URIs are built on it. */
  publicUrl: string;
  /** Origins `returnTo` may point at: the public URL's, and `WEB_ORIGIN` in development. */
  returnOrigins: string[];
  state: StateSigner;
  google: OAuthClient | null;
  microsoft: OAuthClient | null;
};

/** A registered OAuth client and its endpoints (overridden in tests). */
export type OAuthClient = { clientId: string; clientSecret: string; authorizeUrl: string; tokenUrl: string };

const OAuthState = z.object({
  v: z.literal(1),
  provider: z.enum(accountProvider.enumValues),
  userId: z.string(),
  tenantId: z.string().transform((id, ctx) => {
    const tenantId = parseTenantId(id);
    if (tenantId) return tenantId;
    ctx.addIssue({ code: 'custom', message: 'not a tenant id' });
    return z.NEVER;
  }),
  flowId: z.string(),
  returnTo: z.url(),
  /** Incremental consent: the extra scopes asked for, on behalf of this existing account. */
  consent: z.object({ accountId: z.string(), scopes: z.array(z.string()) }).optional(),
  exp: z.number(),
});
export type OAuthState = z.infer<typeof OAuthState>;

export type StateSigner = ReturnType<typeof createStateSigner>;

/** Signs and verifies `state` tokens: `<base64url JSON>.<base64url HMAC>`. The key is derived from `secret` for this use only. */
export function createStateSigner(secret: string) {
  const key = createHash('sha256').update(`supercal oauth state\0${secret}`).digest();
  const mac = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return {
    sign(state: Omit<OAuthState, 'v' | 'exp'>, now = Date.now()): string {
      const payload = Buffer.from(JSON.stringify({ v: 1, ...state, exp: now + STATE_TTL_MS })).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    /** The state, or null when it is malformed, tampered with or expired. */
    verify(token: string | undefined, now = Date.now()): OAuthState | null {
      const [payload, signature, extra] = (token ?? '').split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const expected = mac(payload);
      const given = Buffer.from(signature, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      const parsed = OAuthState.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      return parsed.success && parsed.data.exp > now ? parsed.data : null;
    },
  };
}

/**
 * `returnTo` as an absolute URL when it is a path (resolved on the public URL) or a URL on one of
 * `origins`; null otherwise, which callers answer with a 400.
 */
export function allowedReturnTo(returnTo: string, origins: readonly string[]): string | null {
  const base = origins[0];
  if (!base) return null;
  const isPath = returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\');
  const url = URL.parse(returnTo, isPath ? base : undefined);
  return url && (url.protocol === 'https:' || url.protocol === 'http:') && origins.includes(url.origin) ? url.href : null;
}

/** Thrown inside a callback for a failure the browser is sent back with, as `error=<code>`. */
export class CallbackFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A provider's error code reduced to `[a-z0-9_]`, safe to put in the redirect; `fallback` when nothing is left. */
export const errorCode = (code: string, fallback: string) => code.replace(/[^a-z0-9_]/g, '') || fallback;

/** `returnTo` with `params` added to its query, for the callback's final redirect. */
export function redirectWith(returnTo: string, params: Record<string, string>): string {
  const url = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** Stores a new pending flow with a fresh PKCE verifier (pruning expired ones) and returns its id and S256 challenge. */
export async function beginFlow(tx: TenantTx, { tenantId, userId, provider }: { tenantId: TenantId; userId: string; provider: AccountProvider }) {
  const flowId = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(32));
  await tx.delete(oauthFlow).where(lt(oauthFlow.expiresAt, sql`clock_timestamp()`));
  await tx.insert(oauthFlow).values({ id: flowId, tenantId, userId, provider, verifier, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
  return { flowId, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** Takes the flow `state` refers to: its verifier, once. Null when it was used, expired or belongs to someone else. */
export async function takeFlow(tx: TenantTx, state: OAuthState): Promise<string | null> {
  const [row] = await tx
    .delete(oauthFlow)
    .where(and(eq(oauthFlow.id, state.flowId), eq(oauthFlow.userId, state.userId), eq(oauthFlow.provider, state.provider), gt(oauthFlow.expiresAt, sql`clock_timestamp()`)))
    .returning({ verifier: oauthFlow.verifier });
  return row?.verifier ?? null;
}
