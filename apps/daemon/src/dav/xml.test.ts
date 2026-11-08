import { expect, test } from 'bun:test';
import { XMLParser } from 'fast-xml-parser';
import { NS, child, parseXml, xmlWriter } from './xml.ts';

// One request in the three prefix styles real clients use: default namespace, D:/C:, and A: with a nested redeclaration.
const variants = [
  `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><prop><displayname/><C:calendar-home-set/></prop></propfind>`,
  `<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><x1:calendar-home-set xmlns:x1="urn:ietf:params:xml:ns:caldav"/></D:prop></D:propfind>`,
  `<A:propfind xmlns:A="DAV:"><A:prop xmlns:B="urn:ietf:params:xml:ns:caldav"><A:displayname/><B:calendar-home-set/></A:prop></A:propfind>`,
];

test('namespace resolution is prefix independent', () => {
  for (const v of variants) {
    const root = parseXml(v);
    expect(root?.ns).toBe(NS.DAV);
    const prop = child(root, NS.DAV, 'prop');
    expect(prop?.children.map((c) => `${c.ns}|${c.name}`)).toEqual(['DAV:|displayname', `${NS.CALDAV}|calendar-home-set`]);
  }
});

test('a foreign element named like a DAV one stays distinct (fast-xml-parser alone merges them)', () => {
  const tricky = `<D:propfind xmlns:D="DAV:" xmlns:Z="urn:evil"><Z:prop/><D:prop><D:getetag/></D:prop></D:propfind>`;
  const naive = new XMLParser({ removeNSPrefix: true }).parse(tricky) as { propfind: { prop: unknown } };
  expect(Array.isArray(naive.propfind.prop)).toBe(true);
  expect(child(parseXml(tricky), NS.DAV, 'prop')?.children[0]?.name).toBe('getetag');
});

test('unknown output namespaces get a generated prefix declared on the root', () => {
  const w = xmlWriter();
  const body = `<${w.qname(NS.DAV, 'href')}/><${w.qname('urn:x', 'thing')}/>`;
  expect(w.document('d:multistatus', body)).toBe(
    `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/" xmlns:x0="urn:x"><d:href/><x0:thing/></d:multistatus>`,
  );
});
