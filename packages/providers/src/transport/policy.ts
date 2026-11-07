import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** Operator LAN exceptions from `SUPERCAL_EGRESS_ALLOW`. Tenants can never set this. */
export type EgressPolicy = {
  allow: { origin: string; cidrs: string[] }[];
};

export type EgressBlockReason =
  | 'scheme'
  | 'credentials-in-url'
  | 'address'
  | 'mixed-dns'
  | 'downgrade'
  | 'too-many-redirects'
  | 'proxy-env';

/** Thrown when the guard refuses a request. Messages name hosts or addresses, never full URLs. */
export class EgressBlockedError extends Error {
  override readonly name = 'EgressBlockedError';
  constructor(
    readonly reason: EgressBlockReason,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves every A/AAAA record for a host. Tests inject one so no real DNS is needed. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

type Network = ReturnType<typeof ipaddr.parseCIDR>;
export type AllowRules = { origin: string; networks: Network[] }[];

/** Global unicast only. `ipaddr.process` unwraps IPv4-mapped IPv6 before classifying. */
export function isPublicIp(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

/** Parses with WHATWG `URL` (which normalises integer and hex IPv4), maps `webcal:` to `https:`, and rejects other schemes and userinfo. */
export function normalizeUrl(input: string): URL {
  const url = new URL(input.replace(/^webcal:/i, 'https:'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressBlockedError('scheme', `Scheme ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new EgressBlockedError('credentials-in-url', 'Credentials in URLs are not allowed');
  if (!url.hostname || url.hostname.includes('%')) throw new EgressBlockedError('address', 'Invalid hostname');
  url.hash = '';
  return url;
}

/** Parses the allowlist once so a bad origin or CIDR fails at startup, not on first use. */
export function compileAllow(allow: EgressPolicy['allow']): AllowRules {
  return allow.map((rule) => ({ origin: normalizeUrl(rule.origin).origin, networks: rule.cidrs.map((cidr) => ipaddr.parseCIDR(cidr)) }));
}

/** A non-global address passes only when the origin matches exactly and the address is inside one of that origin's CIDRs. */
function explicitlyAllowed(url: URL, address: string, rules: AllowRules): boolean {
  const ip = ipaddr.process(address);
  return rules.some(
    (rule) => rule.origin === url.origin && rule.networks.some(([network, prefix]) => ip.kind() === network.kind() && ip.match(network, prefix)),
  );
}

/** Rejects with `signal.reason` when the signal fires first. DNS lookups cannot be cancelled, only abandoned. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Resolves the host and vets every answer, failing closed on a mixed public/private answer rather
 * than checking only the address that gets dialled. Returns the one address to connect to.
 */
export async function resolveTarget(url: URL, rules: AllowRules, resolve: Resolver, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const answers = family ? [{ address: host, family }] : await abortable(resolve(host), signal);
  if (!answers.length) throw new Error(`DNS returned no addresses for ${host}`);
  const blocked = answers.filter((a) => !isPublicIp(a.address) && !explicitlyAllowed(url, a.address, rules));
  if (blocked.length === answers.length) throw new EgressBlockedError('address', `Blocked address ${blocked[0]!.address} for ${host}`);
  if (blocked.length) throw new EgressBlockedError('mixed-dns', `Mixed DNS answer for ${host} includes blocked ${blocked[0]!.address}`);
  // No dual-stack failover: only the first vetted address is dialled.
  return answers[0]!;
}
