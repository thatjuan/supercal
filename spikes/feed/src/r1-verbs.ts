// R1 probe: does Bun.serve + Hono route WebDAV verbs with bodies and return 207?
import { Hono } from "hono";

const app = new Hono();
app.on(["PROPFIND", "REPORT", "OPTIONS", "PROPPATCH", "MKCALENDAR"], "/dav/*", async (c) => {
  const body = await c.req.text();
  return c.body(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${c.req.path}</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response></d:multistatus>`,
    207,
    { "Content-Type": "application/xml; charset=utf-8", "X-Method": c.req.method, "X-Depth": c.req.header("Depth") ?? "none", "X-Body-Len": String(body.length) },
  );
});

const server = Bun.serve({ port: 0, fetch: app.fetch });
const base = `http://localhost:${server.port}`;
const body = `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>`;
for (const method of ["PROPFIND", "REPORT", "OPTIONS", "PROPPATCH", "MKCALENDAR"]) {
  const r = await fetch(`${base}/dav/u/cal/`, { method, body: method === "OPTIONS" ? undefined : body, headers: { Depth: "1", "Content-Type": "application/xml" } });
  console.log(method, r.status, r.headers.get("x-method"), "depth=" + r.headers.get("x-depth"), "bodylen=" + r.headers.get("x-body-len"));
}
// curl check: chunked PROPFIND body (async spawn so the server in this process can answer)
const proc = Bun.spawn(["curl", "-s", "-i", "-X", "PROPFIND", "-H", "Depth: 0", "-H", "Transfer-Encoding: chunked", "--data-binary", body, `${base}/dav/u/`]);
const out = await new Response(proc.stdout).text();
console.log("curl chunked PROPFIND ->", out.split("\r\n")[0], "|", out.split("\r\n").find((l) => l.toLowerCase().startsWith("x-body-len")));
server.stop();
