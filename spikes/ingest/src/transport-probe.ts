import { guardedRequest } from './ssrf';
const server = Bun.serve({ hostname:'127.0.0.1', port:0, async fetch(r) { const p = new URL(r.url).pathname; if (p === '/loop') return Response.redirect('/loop'); if (p === '/slow') await Bun.sleep(200); return new Response('ok'); } });
const origin = `http://fixture.test:${server.port}`;
const opts = { resolve: async () => [{ address:'127.0.0.1', family:4 }], allow:[{origin, cidrs:['127.0.0.1/32']}] };
for (const path of ['/loop','/slow']) {
 console.log('begin', path); try { console.log(await guardedRequest(origin+path, {}, {...opts,timeoutMs:100,maxRedirects:2})); } catch(e) { console.log('error', String(e)); }
}
server.stop(true);
