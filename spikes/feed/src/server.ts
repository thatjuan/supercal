// Feed spike server: CalDAV (/.well-known/caldav, /dav) + ICS (/ics) on one Bun.serve.
import { Hono } from "hono";
import { dav } from "./dav";
import { ics } from "./ics";

const app = new Hono();
if (process.env.LOG) app.use("*", async (c, next) => {
  const t = performance.now();
  await next();
  console.log(c.req.method, c.req.path, c.req.header("Depth") ?? "", c.res.status, `${(performance.now() - t).toFixed(1)}ms`);
});
app.route("/", dav);
app.route("/", ics);

const port = Number(process.env.PORT ?? 5232);
Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch });
console.log(`feed spike on http://localhost:${port}`);
