// Send the same Apple-style PROPFINDs to Radicale (reference) and to our server; print, per
// property, the status each returns, so missing/extra properties stand out.
// Property sets follow what sabre.io/dav/clients/ical documents macOS Calendar asking for.
import { NS, children, parseXml, type XmlEl } from "../src/xml";

const OURS = { base: "http://localhost:5232", auth: "meridian:meridian-app-pw", principal: "/dav/principals/meridian/", home: "/dav/calendars/meridian/", cal: "/dav/calendars/meridian/work/" };
const RAD = { base: "http://hare:55232", auth: "meridian:x", principal: "/meridian/", home: "/meridian/", cal: "/meridian/feedref/" };

const principalBody = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/"><A:prop>
<C:calendar-home-set/><C:calendar-user-address-set/><A:current-user-principal/><A:displayname/><CS:dropbox-home-URL/>
<CS:email-address-set/><A:principal-collection-set/><A:principal-URL/><A:resource-id/><C:schedule-inbox-URL/><C:schedule-outbox-URL/>
<A:supported-report-set/></A:prop></A:propfind>`;

const homeBody = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:B="http://apple.com/ns/ical/" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:D="http://calendarserver.org/ns/"><A:prop>
<B:calendar-color/><B:calendar-order/><C:calendar-description/><C:calendar-timezone/><C:supported-calendar-component-set/>
<C:supported-calendar-data/><C:max-resource-size/><C:schedule-calendar-transp/><D:getctag/><D:source/><D:subscribed-strip-alarms/>
<D:push-transports/><D:pushkey/><A:add-member/><A:current-user-privilege-set/><A:displayname/><A:owner/>
<A:quota-available-bytes/><A:quota-used-bytes/><A:resource-id/><A:resourcetype/><A:sync-token/><A:supported-report-set/>
</A:prop></A:propfind>`;

type Server = typeof OURS;
async function propfind(s: Server, path: string, depth: string, body: string) {
  const r = await fetch(s.base + path, { method: "PROPFIND", body, headers: { Depth: depth, "Content-Type": "application/xml", Authorization: "Basic " + btoa(s.auth) } });
  const root = parseXml(await r.text());
  const out = new Map<string, Map<string, string>>(); // href -> prop -> status
  for (const resp of children(root, NS.DAV, "response")) {
    const href = children(resp, NS.DAV, "href")[0]?.text ?? "?";
    const m = new Map<string, string>();
    for (const ps of children(resp, NS.DAV, "propstat")) {
      const status = children(ps, NS.DAV, "status")[0]?.text.split(" ")[1] ?? "?";
      for (const p of children(ps, NS.DAV, "prop")[0]?.children ?? []) m.set(`${short(p.ns)}:${p.name}`, status + summarize(p));
    }
    out.set(href, m);
  }
  return { status: r.status, out };
}
const short = (ns: string) => ({ [NS.DAV]: "D", [NS.CALDAV]: "C", [NS.CS]: "CS", [NS.APPLE]: "A" })[ns] ?? ns;
const summarize = (p: XmlEl): string => {
  const kids = p.children.map((c) => (c.name === "href" ? c.text : c.name === "privilege" || c.name === "supported-report" ? c.children.map((x) => x.children[0]?.name ?? x.name).join("") : c.name + (c.attrs["name"] ? `=${c.attrs["name"]}` : "")));
  const v = kids.length ? kids.join(",") : p.text;
  return v ? ` [${v.slice(0, 70)}]` : "";
};

function table(label: string, a: Map<string, string> | undefined, b: Map<string, string> | undefined) {
  console.log(`\n## ${label}\n| property | Radicale | Supercal |\n|---|---|---|`);
  const keys = new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])]);
  for (const k of [...keys].sort()) console.log(`| ${k} | ${a?.get(k) ?? "-"} | ${b?.get(k) ?? "-"} |`);
}

const rp = await propfind(RAD, RAD.principal, "0", principalBody);
const op = await propfind(OURS, OURS.principal, "0", principalBody);
table(`principal PROPFIND Depth 0 (Radicale ${rp.status}, ours ${op.status})`, rp.out.get(RAD.principal), op.out.get(OURS.principal));
const rh = await propfind(RAD, RAD.home, "1", homeBody);
const oh = await propfind(OURS, OURS.home, "1", homeBody);
table(`calendar collection in home Depth 1 (Radicale ${rh.status}, ours ${oh.status})`, rh.out.get(RAD.cal), oh.out.get(OURS.cal));
