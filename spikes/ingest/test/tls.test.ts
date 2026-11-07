import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { request } from 'node:https';
import { guardedRequest } from '../src/ssrf';

test('Bun 1.3.4 IP pinning: native fetch versus node:https, certificate hostname validated', async () => {
  const temp = mkdtempSync(join(import.meta.dir, '.tls-'));
  const keyPath = join(temp, 'key.pem'), certPath = join(temp, 'cert.pem');
  const result = Bun.spawnSync(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=calendar.test','-addext','subjectAltName=DNS:calendar.test']);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const key = readFileSync(keyPath, 'utf8'), cert = readFileSync(certPath, 'utf8');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key, cert }, fetch(r) { return new Response(r.headers.get('host')); } });
  try {
    const origin = `https://calendar.test:${server.port}`;
    const bad = `https://wrong.test:${server.port}`;
    for (const hostname of ['calendar.test', 'wrong.test']) {
      for (const custom of [false, true]) {
        try {
          const native = await fetch(`https://127.0.0.1:${server.port}/`, { headers:{Host:`${hostname}:${server.port}`}, tls:{ ca:cert, serverName:hostname, ...(custom ? { checkServerIdentity: (_host: string, peer: import("node:tls").PeerCertificate) => checkServerIdentity(hostname, peer) } : {}) }, redirect:'manual', signal:AbortSignal.timeout(2000) });
          console.log('native', hostname, 'custom check', custom, native.status, await native.text());
        } catch (e) { console.log('native', hostname, 'custom check', custom, String(e)); }
      }
    }
    const opts = { ca:cert, allow:[{origin, cidrs:['127.0.0.1/32']}], resolve: async () => [{ address:'127.0.0.1', family:4 }] };
    const good = await guardedRequest(origin, {}, opts); expect(good.text).toBe(`calendar.test:${server.port}`);
    console.log('guarded Bun.fetch original identity + pinned IP: PASS');
    await expect(guardedRequest(bad, {}, { ...opts, allow:[{origin:bad, cidrs:['127.0.0.1/32']}] })).rejects.toThrow();
    console.log('guarded Bun.fetch wrong hostname: REJECTED');
    const child = Bun.spawn([process.execPath, '-e', `import {guardedRequest} from './src/ssrf.ts'; try { await guardedRequest(process.env.TLS_TEST_URL!, {}, {allow:[{origin:process.env.TLS_TEST_URL!,cidrs:['127.0.0.1/32']}],resolve:async()=>[{address:'127.0.0.1',family:4}]}); process.exit(2); } catch(e) {console.log(String(e));process.exit(0)}`], {cwd:join(import.meta.dir,'..'),env:{PATH:process.env.PATH,TLS_TEST_URL:origin},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(0); const message = await new Response(child.stdout).text(); expect(message).toContain('self signed'); console.log('fresh-process untrusted certificate: REJECTED');


    try {
      const native = await fetch(`https://127.0.0.1:${server.port}/`, { headers:{Host:`calendar.test:${server.port}`}, tls:{ ca:cert, serverName:'calendar.test' }, redirect:'manual', signal:AbortSignal.timeout(2000) });
      console.log('Bun.fetch tls.serverName outcome:', native.status, await native.text());
    } catch (e) { console.log('Bun.fetch tls.serverName outcome:', String(e)); }
    try {
      const native = await fetch(`https://127.0.0.1:${server.port}/`, { headers:{Host:`wrong.test:${server.port}`}, tls:{ ca:cert, serverName:'wrong.test' }, redirect:'manual', signal:AbortSignal.timeout(2000) });
      console.log('Bun.fetch wrong serverName outcome:', native.status, await native.text());
    } catch (e) { console.log('Bun.fetch wrong serverName outcome:', String(e)); }
  } finally { server.stop(true); rmSync(temp, { recursive:true }); }
});
