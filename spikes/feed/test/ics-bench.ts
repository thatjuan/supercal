// Q6: render time and size of the 5,000-event "big" publication, plus HTTP caching behaviour.
// Needs the server running on :5232 (bun src/server.ts) for the HTTP part.
import { brotliCompressSync, constants } from "node:zlib";
import { renderIcs } from "../src/ics";
import { type Feed, type Publication, sql, view } from "../src/store";

const [feed] = await sql<Feed[]>`select * from feed where username = 'bench'`;
const [pub] = await sql<Publication[]>`select * from publication where slug = 'big'`;
if (!feed || !pub) throw new Error("seed first");

const ms = (t: number) => `${(performance.now() - t).toFixed(0)}ms`;
for (let i = 0; i < 4; i++) {
  let t = performance.now();
  const v = await view(pub);
  const tDb = ms(t);
  t = performance.now();
  const ics = await renderIcs(feed, [pub], "Big");
  const tAll = ms(t);
  const raw = new TextEncoder().encode(ics);
  t = performance.now();
  const gz = Bun.gzipSync(raw);
  const tGz = ms(t);
  t = performance.now();
  const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  const tBr = ms(t);
  if (i === 0 || i === 3) {
    console.log(`run ${i}: ${v.items.size} resources | db+merge ${tDb} | full render (db+project+serialise) ${tAll} | raw ${(raw.length / 1024).toFixed(0)} KiB | gzip ${(gz.length / 1024).toFixed(0)} KiB in ${tGz} | br q5 ${(br.length / 1024).toFixed(0)} KiB in ${tBr}`);
  }
}

const url = "http://localhost:5232/ics/ics-bench-secret/big.ics";
const timed = async (h: Record<string, string>) => {
  const t = performance.now();
  const r = await fetch(url, { headers: h, decompress: false } as RequestInit);
  const body = new Uint8Array(await r.arrayBuffer());
  return { r, len: body.length, t: ms(t) };
};
const a = await timed({ "Accept-Encoding": "identity" });
console.log(`GET identity: ${a.r.status} ${a.len} bytes ${a.t} (first request, cache miss) ETag=${a.r.headers.get("etag")} Last-Modified=${a.r.headers.get("last-modified")}`);
const b = await timed({ "Accept-Encoding": "gzip" });
console.log(`GET gzip: ${b.r.status} ${b.r.headers.get("content-encoding")} ${b.len} bytes ${b.t} (render cached)`);
const c = await timed({ "Accept-Encoding": "br, gzip" });
console.log(`GET br: ${c.r.status} ${c.r.headers.get("content-encoding")} ${c.len} bytes ${c.t}`);
const d = await timed({ "If-None-Match": a.r.headers.get("etag") ?? "" });
console.log(`GET If-None-Match: ${d.r.status} ${d.len} bytes ${d.t}`);
const e = await timed({ "If-Modified-Since": a.r.headers.get("last-modified") ?? "" });
console.log(`GET If-Modified-Since: ${e.r.status} ${e.len} bytes ${e.t}`);
const bad = await fetch("http://localhost:5232/ics/wrong-token/big.ics");
console.log(`GET wrong token: ${bad.status}`);
await sql.close();
