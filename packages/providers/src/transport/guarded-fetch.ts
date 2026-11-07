import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { compileAllow, EgressBlockedError, type EgressPolicy, normalizeUrl, type Resolver, resolveTarget, systemResolver } from './policy.ts';

export type GuardedRequest = {
  /** http(s) or webcal; webcal becomes https. */
  url: string;
  method?: 'GET' | 'PROPFIND' | 'REPORT' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
  credentials?: { kind: 'basic'; username: string; password: string } | { kind: 'bearer'; token: string };
  /** Hosts that keep credentials across cross-origin redirects: exact (`caldav.icloud.com`) or `*.icloud.com` for any subdomain. */
  credentialHosts?: string[];
  /** Default 8 MiB, enforced on the wire and decoded body separately. */
  maxBytes?: number;
  /** Default 10 s, covering DNS, connect and body for every hop. */
  timeoutMs?: number;
  /** Default 5. */
  maxRedirects?: number;
  signal?: AbortSignal;
};

export type GuardedResponse = { status: number; headers: Headers; body: Uint8Array; finalUrl: string };

export type GuardedFetch = (req: GuardedRequest) => Promise<GuardedResponse>;

export type GuardedFetchOptions = {
  resolve?: Resolver;
  /** Called once per hop with the host and status only; full URLs and bodies are never logged. */
  log?: (entry: { host: string; status: number }) => void;
};

const MiB = 1024 * 1024;
const PROXY_VARIABLES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const ORIGIN_BOUND_HEADERS = ['authorization', 'cookie', 'if-none-match', 'if-modified-since'];
const DECODERS = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync };

const isDecodable = (encoding: string): encoding is keyof typeof DECODERS => Object.hasOwn(DECODERS, encoding);

const hostMatches = (host: string, patterns: string[]) =>
  patterns.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1).toLowerCase()) : host === pattern.toLowerCase()));

function authorization(credentials: NonNullable<GuardedRequest['credentials']>): string {
  return credentials.kind === 'basic'
    ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
    : `Bearer ${credentials.token}`;
}

/**
 * Builds `guardedFetch`, the only way Supercal fetches a URL a user influenced (ICS feeds, CalDAV,
 * discovery, redirects, server-returned hrefs). Each hop re-validates the URL and DNS, dials the
 * vetted IP, and checks the certificate against the original hostname. TLS trust is the process's
 * fixed roots (system plus `NODE_EXTRA_CA_CERTS`); there is deliberately no per-request CA option.
 */
export function createGuardedFetch(policy: EgressPolicy, { resolve = systemResolver, log }: GuardedFetchOptions = {}): GuardedFetch {
  const rules = compileAllow(policy.allow);

  return async (req) => {
    // Bun 1.3.4 uses ambient proxies even with `proxy: ''`, which would bypass IP pinning.
    if (Object.keys(process.env).some((key) => PROXY_VARIABLES.has(key.toUpperCase()) && process.env[key])) {
      throw new EgressBlockedError('proxy-env', 'Guarded transport requires a proxy-free environment');
    }
    const { method = 'GET', maxBytes = 8 * MiB, timeoutMs = 10_000, maxRedirects = 5, credentialHosts = [] } = req;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const headers = new Headers(req.headers);
    if (req.credentials) headers.set('authorization', authorization(req.credentials));
    let current = normalizeUrl(req.url);

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const target = await resolveTarget(current, rules, resolve, signal);
      const hostname = current.hostname.replace(/^\[|\]$/g, '');
      const pinned = new URL(current);
      pinned.hostname = target.family === 6 ? `[${target.address}]` : target.address;
      headers.set('host', current.host);
      headers.set('accept-encoding', 'gzip, deflate, br');
      // Bun 1.3.4 rejects valid certificates for an IP-pinned URL unless checkServerIdentity is
      // given explicitly. keepalive is off so a pooled connection to the same IP, verified for a
      // different hostname, is never reused.
      const response = await fetch(pinned, {
        method,
        headers,
        body: req.body ?? null,
        redirect: 'manual',
        signal,
        decompress: false,
        keepalive: false,
        tls: { serverName: hostname, rejectUnauthorized: true, checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert) },
      });
      log?.({ host: current.host, status: response.status });

      if (!REDIRECTS.has(response.status)) {
        return { status: response.status, headers: response.headers, body: await readBody(response, maxBytes), finalUrl: current.href };
      }
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect without Location from ${current.host}`);
      const next = normalizeUrl(new URL(location, current).href);
      if (current.protocol === 'https:' && next.protocol !== 'https:') throw new EgressBlockedError('downgrade', `HTTPS downgrade from ${current.host}`);
      if (response.status === 303 && method !== 'GET') throw new Error(`Unexpected method-changing redirect from ${current.host}`);
      if (next.origin !== current.origin && !hostMatches(next.hostname, credentialHosts)) {
        for (const key of ORIGIN_BOUND_HEADERS) headers.delete(key);
      }
      current = next;
    }
    throw new EgressBlockedError('too-many-redirects', `More than ${maxRedirects} redirects`);
  };
}

/**
 * Reads the body with `maxBytes` on the wire, then decodes gzip, deflate or br with
 * `maxOutputLength`, so neither a large body nor a decompression bomb can exceed the limit.
 */
async function readBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Body too large');
  }
  const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? 'identity';
  if (encoding !== 'identity' && !isDecodable(encoding)) {
    await response.body?.cancel();
    throw new Error(`Unsupported content encoding ${encoding}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        size += chunk.value.length;
        if (size > maxBytes) throw new Error('Body too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
  }
  const wire = Buffer.concat(chunks);
  if (encoding === 'identity') return wire;
  try {
    return DECODERS[encoding](wire, { maxOutputLength: maxBytes });
  } catch (cause) {
    throw new Error('Body too large or invalid compressed body', { cause });
  }
}
