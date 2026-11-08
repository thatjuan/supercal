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

const configSchema = z
  .object({
    PORT: z.coerce.number({ error: 'must be a port number' }).int().min(0).max(65_535).default(4316),
    DATABASE_URL: required,
    DATABASE_MIGRATION_URL: optional,
    SUPERCAL_PUBLIC_URL: url.optional(),
    SUPERCAL_KEYS: optional,
    BETTER_AUTH_SECRET: optional,
    SUPERCAL_ROLES: rolesSchema.default(new Set(['api', 'dav', 'worker'])),
    SUPERCAL_MIGRATE: z.enum(['auto', 'off']).default('auto'),
    SUPERCAL_SIGNUP: z.enum(['open', 'invite', 'disabled']).default('invite'),
    SUPERCAL_INSECURE_DEV: z
      .enum(['0', '1'])
      .default('0')
      .transform((flag) => flag === '1'),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    MICROSOFT_CLIENT_ID: optional,
    MICROSOFT_CLIENT_SECRET: optional,
    SUPERCAL_EGRESS_ALLOW: egressAllow.default([]),
    /** Bound on cached ICS bodies, in MiB. */
    SUPERCAL_ICS_CACHE_MB: z.coerce.number({ error: 'must be a number of MiB' }).min(0).default(64),
    SUPERCAL_SYNC_CONCURRENCY: z.coerce.number({ error: 'must be a number' }).int().min(1).max(256).default(8),
    RESEND_API_KEY: optional,
    MAIL_FROM: optional,
    WEB_ORIGIN: url.optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.SUPERCAL_INSECURE_DEV) {
      for (const key of ['SUPERCAL_PUBLIC_URL', 'SUPERCAL_KEYS', 'BETTER_AUTH_SECRET'] as const) {
        if (config[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'is required unless SUPERCAL_INSECURE_DEV=1' });
      }
      if (config.SUPERCAL_PUBLIC_URL?.startsWith('http:')) {
        ctx.addIssue({ code: 'custom', path: ['SUPERCAL_PUBLIC_URL'], message: 'must use https: unless SUPERCAL_INSECURE_DEV=1' });
      }
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
