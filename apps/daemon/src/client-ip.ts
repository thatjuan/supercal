import { isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

/** Private header overwritten by the API before Better Auth reads the client address. */
export const CLIENT_IP_HEADER = 'x-supercal-client-ip';

/** The address throttles and rate limits key on. Trusts `header` only when the operator names one, and reads the last entry, the one the nearest proxy wrote. */
export function clientIp(c: Context, header: string | undefined): string | null {
  const forwarded = header && c.req.header(header)?.split(',').at(-1)?.trim();
  if (forwarded && isIP(forwarded)) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // app.request in tests has no socket.
  }
}
