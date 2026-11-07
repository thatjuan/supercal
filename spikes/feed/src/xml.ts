// Namespace-aware XML for WebDAV. fast-xml-parser keeps raw prefixes ("D:prop", "x0:prop") and
// `removeNSPrefix` just drops them, so neither is namespace-correct. We parse with preserveOrder,
// then resolve every element to { ns, name } by walking xmlns declarations ourselves.
import { XMLParser } from "fast-xml-parser";

export const NS = {
  DAV: "DAV:",
  CALDAV: "urn:ietf:params:xml:ns:caldav",
  CS: "http://calendarserver.org/ns/",
  APPLE: "http://apple.com/ns/ical/",
} as const;

export type XmlEl = { ns: string; name: string; attrs: Record<string, string>; children: XmlEl[]; text: string };

type RawNode = Record<string, RawNode[] | string | Record<string, string>>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

export function parseXml(src: string): XmlEl | undefined {
  const raw = parser.parse(src) as RawNode[];
  const root = convert(raw, {}).find((e) => e.name);
  return root;
}

function convert(nodes: RawNode[], scope: Record<string, string>): XmlEl[] {
  const out: XmlEl[] = [];
  for (const node of nodes) {
    const attrs = (node[":@"] ?? {}) as Record<string, string>;
    for (const [tag, value] of Object.entries(node)) {
      if (tag === ":@" || tag === "#text" || tag.startsWith("?")) continue;
      const local = { ...scope };
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "xmlns") local[""] = v;
        else if (k.startsWith("xmlns:")) local[k.slice(6)] = v;
      }
      const [prefix, name] = tag.includes(":") ? (tag.split(":", 2) as [string, string]) : ["", tag];
      const kids = Array.isArray(value) ? (value as RawNode[]) : [];
      const text = kids.map((k) => (typeof k["#text"] === "string" ? k["#text"] : "")).join("");
      out.push({ ns: local[prefix] ?? "", name, attrs, children: convert(kids, local), text });
    }
  }
  return out;
}

export const child = (el: XmlEl | undefined, ns: string, name: string) => el?.children.find((c) => c.ns === ns && c.name === name);
export const children = (el: XmlEl | undefined, ns: string, name: string) => el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Output side: fixed prefixes, declared once on the root. Unknown namespaces get x0, x1...
const PREFIX: Record<string, string> = { [NS.DAV]: "d", [NS.CALDAV]: "cal", [NS.CS]: "cs", [NS.APPLE]: "ical" };
export const qname = (ns: string, name: string, extra: Map<string, string>) => {
  let p = PREFIX[ns];
  if (!p) {
    p = extra.get(ns) ?? `x${extra.size}`;
    extra.set(ns, p);
  }
  return `${p}:${name}`;
};
export const rootNsDecls = (extra: Map<string, string>) =>
  [...Object.entries(PREFIX).map(([ns, p]) => `xmlns:${p}="${ns}"`), ...[...extra].map(([ns, p]) => `xmlns:${p}="${esc(ns)}"`)].join(" ");
