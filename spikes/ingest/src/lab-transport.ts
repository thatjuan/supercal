import type { Transport } from './caldav';
/** Only for the explicitly authorised Radicale fixture. Public input uses guarded transport. */
export const labTransport: Transport = async (url, init) => {
  const initial = new URL(url);
  if (initial.origin !== 'http://hare:55232') throw new Error('Not the lab origin');
  let current = initial;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current, { ...init, headers: { ...init.headers, Authorization: `Basic ${btoa('astrolabe:spike')}` }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('Location') ?? '', current);
      if (next.origin !== initial.origin) throw new Error('Cross-origin lab redirect');
      current = next; continue;
    }
    return { status: response.status, text: await response.text(), url: current.href };
  }
  throw new Error('Redirect limit');
};
