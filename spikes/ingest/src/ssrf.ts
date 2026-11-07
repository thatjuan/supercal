import { lookup } from 'node:dns/promises';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import ipaddr from 'ipaddr.js';
import type { Transport } from './caldav';

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export type AllowRule = { origin: string; cidrs: string[] };
export type GuardOptions = { allow?: AllowRule[]; resolve?: Resolver; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; ca?: string };
export type HttpResult = { status: number; headers: Headers; text: string; url: string; address: string };
const defaultResolver: Resolver = host => lookup(host, { all: true, verbatim: true });

export function isPublicIp(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function normalizeUrl(input: string): URL {
  const u = new URL(input.replace(/^webcal:/i, 'https:'));
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S)');
  if (u.username || u.password) throw new Error('URL credentials forbidden');
  if (!u.hostname || u.hostname.includes('%')) throw new Error('Invalid hostname');
  u.hash = ''; return u;
}
function explicitlyAllowed(u: URL, address: string, rules: AllowRule[]) {
  const ip = ipaddr.process(address);
  return rules.some(rule => normalizeUrl(rule.origin).origin === u.origin && rule.cidrs.some(cidr => {
    const [network, prefix] = ipaddr.parseCIDR(cidr);
    return ip.kind() === network.kind() && ip.match(network, prefix);
  }));
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function resolveTarget(url: URL, options: GuardOptions, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await bounded((options.resolve ?? defaultResolver)(host), signal);
  if (!addresses.length) throw new Error('DNS returned no addresses');
  // Fail closed on mixed public/private answers, not just the address picked for this attempt.
  for (const a of addresses) if (!isPublicIp(a.address) && !explicitlyAllowed(url, a.address, options.allow ?? [])) throw new Error(`Blocked address ${a.address}`);
  return addresses[0]!;
}

/** Dial the vetted numeric address, preserving HTTP Host, TLS SNI and certificate validation. No DNS or proxy at connect time. */
export async function guardedRequest(input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, options: GuardOptions = {}): Promise<HttpResult> {
  if (['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].some(key => process.env[key])) throw new Error('Guarded transport requires proxy-free worker environment');
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10000);
  let current = normalizeUrl(input);
  let headers = new Headers(init.headers);
  const method = init.method ?? 'GET';
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    const target = await resolveTarget(current, options, signal); signal.throwIfAborted();
    headers.set('Host', current.host); headers.set('Accept-Encoding', 'gzip, deflate, br');
    const pinned = new URL(current); pinned.hostname = target.family === 6 ? `[${target.address}]` : target.address;
    const originalHostname = current.hostname.replace(/^\[|\]$/g, '');
    const response = await fetch(pinned, { method, headers, body: init.body, redirect: 'manual', signal,
      proxy: '', decompress: false, keepalive: false,
      tls: { ca: options.ca, serverName: originalHostname, rejectUnauthorized: true,
        checkServerIdentity: (_hostname: string, certificate: import("node:tls").PeerCertificate) => checkServerIdentity(originalHostname, certificate) } });
    const status = response.status; const responseHeaders = response.headers;
    if ([301,302,303,307,308].includes(status)) {
      await response.body?.cancel();
      const location = responseHeaders.get('location'); if (!location) throw new Error('Redirect without Location');
      const next = normalizeUrl(new URL(location, current).href);
      if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade');
      if (status === 303 && method !== 'GET') throw new Error('Unexpected method-changing redirect');
      if (next.origin !== current.origin) { headers = new Headers(headers); for (const key of ['authorization','cookie','if-none-match','if-modified-since']) headers.delete(key); }
      current = next; continue;
    }
    const length = Number(responseHeaders.get('content-length'));
    if (length > maxBytes) { await response.body?.cancel(); throw new Error('Body too large'); }
    const encoding = responseHeaders.get('content-encoding')?.toLowerCase();
    if (encoding && !['identity','gzip','deflate','br'].includes(encoding)) { await response.body?.cancel(); throw new Error('Unsupported encoding'); }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw new Error('Body too large'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const wire = Buffer.concat(chunks); let body: Buffer;
    try { body = encoding === 'gzip' ? gunzipSync(wire, { maxOutputLength:maxBytes }) : encoding === 'deflate' ? inflateSync(wire, { maxOutputLength:maxBytes }) : encoding === 'br' ? brotliDecompressSync(wire, { maxOutputLength:maxBytes }) : wire; }
    catch (e) { throw new Error('Body too large or invalid compressed body', { cause:e }); }
    if (body.length > maxBytes) throw new Error('Body too large after decompression');
    return { status, headers: responseHeaders, text: body.toString('utf8'), url: current.href, address: target.address };
  }
  throw new Error('Redirect limit');
}
export function guardedDavTransport(options: GuardOptions, credentialOrigin: string, authorization: string): Transport {
  return (url, init) => guardedRequest(url, { ...init, headers: { ...init.headers, ...(new URL(url).origin === credentialOrigin ? { Authorization: authorization } : {}) } }, options);
}
