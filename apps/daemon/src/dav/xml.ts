/**
 * Namespace-aware XML for WebDAV. fast-xml-parser keeps raw prefixes (`D:prop`, `x0:prop`) and
 * `removeNSPrefix` drops them, so neither is namespace-correct: requests are parsed with
 * `preserveOrder` and every element is resolved to `{ ns, name }` by tracking `xmlns`
 * declarations. Output is string-built with fixed prefixes declared once on the root.
 */
import { XMLParser } from 'fast-xml-parser';

export const NS = {
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CS: 'http://calendarserver.org/ns/',
  APPLE: 'http://apple.com/ns/ical/',
} as const;

export type XmlEl = { ns: string; name: string; attrs: Record<string, string>; children: XmlEl[]; text: string };

type Scope = Record<string, string>;

type RawNode = Record<string, RawNode[] | string | Record<string, string>>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

/** The root element of `src` with namespaces resolved, or undefined when it has none or is not XML. */
export function parseXml(src: string): XmlEl | undefined {
  try {
    return convert(parser.parse(src) as RawNode[], Object.create(null) as Scope).find((e) => e.name);
  } catch {
    return undefined;
  }
}

function convert(nodes: RawNode[], scope: Scope): XmlEl[] {
  const out: XmlEl[] = [];
  for (const node of nodes) {
    const attrs = (node[':@'] ?? {}) as Record<string, string>;
    for (const [tag, value] of Object.entries(node)) {
      if (tag === ':@' || tag === '#text' || tag.startsWith('?')) continue;
      const declarations = Object.entries(attrs).filter(([k]) => k === 'xmlns' || k.startsWith('xmlns:'));
      const local: Scope = declarations.length ? (Object.create(scope) as Scope) : scope;
      for (const [k, v] of declarations) local[k === 'xmlns' ? '' : k.slice(6)] = v;
      const [prefix, name] = tag.includes(':') ? (tag.split(':', 2) as [string, string]) : ['', tag];
      const kids = Array.isArray(value) ? value : [];
      const text = kids.map((k) => (typeof k['#text'] === 'string' ? k['#text'] : '')).join('');
      out.push({ ns: local[prefix] ?? '', name, attrs, children: convert(kids, local), text });
    }
  }
  return out;
}

export const child = (el: XmlEl | undefined, ns: string, name: string) => el?.children.find((c) => c.ns === ns && c.name === name);
export const children = (el: XmlEl | undefined, ns: string, name: string) => el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
export const is = (el: XmlEl | undefined, ns: string, name: string) => el?.ns === ns && el.name === name;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PREFIX: Record<string, string> = { [NS.DAV]: 'd', [NS.CALDAV]: 'cal', [NS.CS]: 'cs', [NS.APPLE]: 'ical' };

/**
 * Output-side qualified names for one document. Known namespaces use the fixed prefixes; a
 * requested property in any other namespace gets `x0`, `x1`… and is declared on the root too.
 */
export function xmlWriter() {
  const extra = new Map<string, string>();
  return {
    qname(ns: string, name: string) {
      let p = PREFIX[ns] ?? extra.get(ns);
      if (!p) extra.set(ns, (p = `x${extra.size}`));
      return `${p}:${name}`;
    },
    /** The XML declaration and `<root …>body</root>` with every namespace used declared on it. */
    document(root: string, body: string) {
      const decls = [...Object.entries(PREFIX), ...extra].map(([ns, p]) => `xmlns:${p}="${esc(ns)}"`).join(' ');
      return `<?xml version="1.0" encoding="utf-8"?>\n<${root} ${decls}>${body}</${root}>`;
    },
  };
}

export type XmlWriter = ReturnType<typeof xmlWriter>;
