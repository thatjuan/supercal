import { z } from 'zod';
import { rolesSchema } from './roles.ts';

/** Bun ignores `proxy: ''` on 1.3.4, so any ambient proxy would bypass the SSRF guard's IP pinning. */
const PROXY_VARIABLES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);

const required = z.string({ error: 'is required' });
const optional = z.string().optional();
const url = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });
const cidr = z.union([z.cidrv4(), z.cidrv6()]);

/** One `origin=cidr` entry: the exact http(s) origin may reach non-global addresses inside the CIDR. */
const egressRule = z.string().transform((entry, ctx) => {
  const [origin = '', range, extra] = entry.split('=');
  const parsed = URL.parse(origin);
  const network = cidr.safeParse(range);
  if (extra === undefined && parsed && /^https?:$/.test(parsed.protocol) && parsed.href === `${parsed.origin}/` && network.success) {
    return { origin: parsed.origin, cidrs: [network.data] };
  }
  ctx.addIssue({ code: 'custom', message: 'entries must look like https://host[:port]=cidr, separated by commas' });
  return z.NEVER;
});

/** Operator LAN allowlist for the guarded transport, passed to `createGuardedFetch` as `EgressPolicy.allow`. */
const egressAllow = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
  .pipe(z.array(egressRule));

/** Variables that must be set unless `SUPERCAL_INSECURE_DEV=1`. */
export const PRODUCTION_REQUIRED = ['SUPERCAL_PUBLIC_URL', 'SUPERCAL_KEYS', 'BETTER_AUTH_SECRET'] as const;

/**
 * Every environment variable the daemon reads. Each description is the operator documentation:
 * `bun run docs:config` renders them into the table in `docs/self-hosting.md`.
 */
export const configSchema = z
  .object({
    PORT: z.coerce.number({ error: 'must be a port number' }).int().min(0).max(65_535).default(4316).describe('Port the HTTP server listens on.'),
    DATABASE_URL: required.describe('Postgres connection URL the daemon runs on. Recommended: a login that is a member of `supercal_app` and `supercal_control` and owns nothing.'),
    DATABASE_MIGRATION_URL: optional.describe('Postgres URL of the schema owner, used only to apply migrations. Defaults to `DATABASE_URL` (single-URL mode).'),
    SUPERCAL_PUBLIC_URL: url
      .optional()
      .describe('Public https base URL, used in feed links, OAuth redirect URIs and push webhooks. Required unless `SUPERCAL_INSECURE_DEV=1`.'),
    SUPERCAL_CLIENT_IP_HEADER: optional.describe('Header holding the client address, set by a reverse proxy you run. When unset, the socket peer is used.'),
    SUPERCAL_KEYS: optional.describe('Master keys for secrets at rest, `v2:<base64 32 bytes>,v1:…`; the first one encrypts. Required unless `SUPERCAL_INSECURE_DEV=1`.'),
    BETTER_AUTH_SECRET: optional.describe('Secret that signs sessions and OAuth state; at least 32 random characters. Required unless `SUPERCAL_INSECURE_DEV=1`.'),
    SUPERCAL_ROLES: rolesSchema.prefault('api,dav,worker').describe('Comma list of roles this process runs: `api` (API and dashboard), `dav` (CalDAV and ICS feeds), `worker` (sync).'),
    SUPERCAL_MIGRATE: z.enum(['auto', 'off']).default('auto').describe('`auto` applies migrations at boot under an advisory lock; `off` leaves them to `supercal migrate`.'),
    SUPERCAL_SIGNUP: z.enum(['open', 'invite', 'disabled']).default('invite').describe('Who may create an account: anyone (`open`), invitees (`invite`) or nobody (`disabled`). The first user always may, and becomes the operator.'),
    SUPERCAL_INSECURE_DEV: z
      .enum(['0', '1'])
      .default('0')
      .transform((flag) => flag === '1')
      .describe('`1` allows plain http, a built-in development key and insecure cookies. Never in production.'),
    GOOGLE_CLIENT_ID: optional.describe('Google OAuth client id; enables Google accounts. Set together with `GOOGLE_CLIENT_SECRET`.'),
    GOOGLE_CLIENT_SECRET: optional.describe('Google OAuth client secret.'),
    MICROSOFT_CLIENT_ID: optional.describe('Microsoft Entra application (client) id; enables Microsoft accounts. Set together with `MICROSOFT_CLIENT_SECRET`.'),
    MICROSOFT_CLIENT_SECRET: optional.describe('Microsoft Entra client secret value.'),
    SUPERCAL_EGRESS_ALLOW: egressAllow.prefault('').describe('LAN servers accounts may reach, as `https://host[:port]=cidr` entries separated by commas.'),
    SUPERCAL_ICS_CACHE_MB: z.coerce.number({ error: 'must be a number of MiB' }).min(0).default(64).describe('Memory bound, in MiB, of the cache of rendered ICS feeds.'),
    SUPERCAL_SYNC_CONCURRENCY: z.coerce
      .number({ error: 'must be a number' })
      .int()
      .min(1)
      .max(256)
      .default(8)
      .describe('Sync jobs a worker process runs at once (at most 2 per account; one tenant uses at most half, rounded up).'),
    SUPERCAL_METRICS_TOKEN: optional.describe('Required to enable `/metrics` unless `SUPERCAL_INSECURE_DEV=1`; when set, requires `Authorization: Bearer <token>`.'),
    RESEND_API_KEY: optional.describe('Resend API key. With `MAIL_FROM`, enables verification, password-reset, magic-link and invitation email.'),
    MAIL_FROM: optional.describe('Sender of that email, such as `Supercal <cal@example.com>`, on a domain verified in Resend.'),
    WEB_ORIGIN: url.optional().describe('Extra trusted origin for the Vite dev server, such as `http://localhost:5173`. Development only.'),
    SUPERCAL_WEB_DIR: optional.describe('Directory of the built dashboard. Defaults to `web/` next to the binary; the image sets `/app/web`.'),
  })
  .superRefine((config, ctx) => {
    if (!config.SUPERCAL_INSECURE_DEV) {
      for (const key of PRODUCTION_REQUIRED) {
        if (config[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'is required unless SUPERCAL_INSECURE_DEV=1' });
      }
      if (config.SUPERCAL_PUBLIC_URL?.startsWith('http:')) {
        ctx.addIssue({ code: 'custom', path: ['SUPERCAL_PUBLIC_URL'], message: 'must use https: unless SUPERCAL_INSECURE_DEV=1' });
      }
    }
    if ((config.RESEND_API_KEY === undefined) !== (config.MAIL_FROM === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'must be set together with RESEND_API_KEY' });
    }
    for (const provider of ['GOOGLE', 'MICROSOFT'] as const) {
      const id = `${provider}_CLIENT_ID` as const;
      const secret = `${provider}_CLIENT_SECRET` as const;
      if ((config[id] === undefined) !== (config[secret] === undefined)) {
        ctx.addIssue({ code: 'custom', path: [id], message: `must be set together with ${secret}` });
      }
    }
  });

export type Config = Readonly<z.infer<typeof configSchema>>;

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

/**
 * Validates an environment. Empty values count as unset. Problems name the variable and the
 * reason, never the value, so they are safe to print.
 */
export function parseConfig(env: Record<string, string | undefined>): ConfigResult {
  const proxies = Object.keys(env).filter((key) => PROXY_VARIABLES.has(key.toUpperCase()) && env[key]);
  if (proxies.length > 0) {
    return {
      ok: false,
      problems: proxies.map(
        (key) => `${key}: must not be set; Bun ignores per-request proxy overrides, so a proxy would bypass the SSRF guard's direct, IP-pinned connections`,
      ),
    };
  }

  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const result = configSchema.safeParse(set);
  if (result.success) return { ok: true, config: Object.freeze(result.data) };
  return { ok: false, problems: result.error.issues.map((issue) => `${String(issue.path[0] ?? 'config')}: ${issue.message}`) };
}

/** Parses `process.env` once at boot; prints each problem and exits 1 when the config is invalid. */
export function loadConfig(env = process.env): Config {
  const result = parseConfig(env);
  if (result.ok) return result.config;
  for (const problem of result.problems) console.error(`config: ${problem}`);
  process.exit(1);
}
