import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { clientIp } from './client-ip.ts';

function app(header?: string) {
  return new Hono().get('/', (c) => c.json({ ip: clientIp(c, header) }));
}

test('without a configured header, X-Forwarded-For is ignored and a missing socket returns null', async () => {
  const res = await app().request('/', { headers: { 'X-Forwarded-For': '192.0.2.1' } });
  expect(await res.json()).toEqual({ ip: null });
});

test('the configured header uses its last entry, including IPv6', async () => {
  const res = await app('X-Forwarded-For').request('/', { headers: { 'X-Forwarded-For': '192.0.2.1, 2001:db8::2 ' } });
  expect(await res.json()).toEqual({ ip: '2001:db8::2' });
});

test('invalid or absent configured values fall back to the socket peer', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app('X-Forwarded-For').fetch });
  try {
    for (const value of ['not-an-ip', '192.0.2.1, invalid', '192.0.2.1,', '']) {
      const res = await fetch(server.url, { headers: { 'X-Forwarded-For': value } });
      expect(await res.json()).toEqual({ ip: '127.0.0.1' });
    }
  } finally {
    await server.stop(true);
  }
});
