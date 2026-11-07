import { expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";
import { NS, child, parseXml } from "../src/xml";

// Same request, three prefix styles real clients use (default ns, D:/C:, Apple-ish A: + nested redeclare).
const variants = [
  `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><displayname/><C:calendar-home-set/></prop></propfind>`,
  `<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><x1:calendar-home-set xmlns:x1="urn:ietf:params:xml:ns:caldav"/></D:prop></D:propfind>`,
  `<A:propfind xmlns:A="DAV:"><A:prop xmlns:B="urn:ietf:params:xml:ns:caldav"><A:displayname/><B:calendar-home-set/></A:prop></A:propfind>`,
];

test("namespace resolution is prefix independent", () => {
  for (const v of variants) {
    const root = parseXml(v);
    expect(root?.ns).toBe(NS.DAV);
    const prop = child(root, NS.DAV, "prop");
    expect(prop?.children.map((c) => `${c.ns}|${c.name}`)).toEqual(["DAV:|displayname", `${NS.CALDAV}|calendar-home-set`]);
  }
});

test("naive fast-xml-parser is prefix dependent (why we resolve ourselves)", () => {
  const p = new XMLParser({ removeNSPrefix: true });
  // a non-DAV element named "prop" in a foreign ns becomes indistinguishable from DAV:prop
  const tricky = `<D:propfind xmlns:D="DAV:" xmlns:Z="urn:evil"><Z:prop/><D:prop><D:getetag/></D:prop></D:propfind>`;
  const naive = p.parse(tricky) as { propfind: { prop: unknown } };
  expect(Array.isArray(naive.propfind.prop)).toBe(true); // two "prop"s merged: namespace lost
  const ok = parseXml(tricky);
  expect(child(ok, NS.DAV, "prop")?.children[0]?.name).toBe("getetag");
});
