import { strFromU8, unzipSync } from "fflate";

/**
 * The shared floor under the two Office readers (ADR 0054 §4): a ZIP
 * opened with fflate, XML parsed by the browser's DOMParser, and the
 * relationship files that tie parts together. Namespaces are matched by
 * LOCAL NAME on purpose — writers differ in prefixes, and the readers
 * care about the element, not the prefix.
 */
export interface OoxmlPackage {
  /** Part bytes by ZIP path (forward slashes, no leading slash). */
  readonly parts: ReadonlyMap<string, Uint8Array>;
}

export function openPackage(bytes: Uint8Array): OoxmlPackage {
  const unzipped = unzipSync(bytes);
  const parts = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unzipped)) {
    parts.set(name.replace(/^\/+/, ""), data);
  }
  return { parts };
}

export function partText(pkg: OoxmlPackage, path: string): string | null {
  const data = pkg.parts.get(path);
  return data === undefined ? null : strFromU8(data);
}

export function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  // DOMParser reports XML errors as a document with a parsererror node.
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

export function partXml(pkg: OoxmlPackage, path: string): Document | null {
  const text = partText(pkg, path);
  return text === null ? null : parseXml(text);
}

/** Direct children of `el` with the given local name. */
export function children(el: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (const c of el.children) if (c.localName === localName) out.push(c);
  return out;
}

/** First direct child with the local name, or null. */
export function child(el: Element, localName: string): Element | null {
  for (const c of el.children) if (c.localName === localName) return c;
  return null;
}

/** Every descendant with the local name, document order. */
export function descendants(root: ParentNode, localName: string): Element[] {
  const out: Element[] = [];
  const walk = (n: ParentNode): void => {
    for (const c of n.children) {
      if (c.localName === localName) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** An attribute by local name, prefix-agnostic (`r:id` and `id` alike). */
export function attr(el: Element, localName: string): string | null {
  const direct = el.getAttribute(localName);
  if (direct !== null) return direct;
  for (const a of el.attributes) if (a.localName === localName) return a.value;
  return null;
}

/** A RELATIONSHIP attribute (`r:id`, `r:embed`): matched by prefix or
 *  namespace, never by bare name — `p:sldId` carries both `id="256"` and
 *  `r:id="rId1"`, and the bare lookup answers the wrong one. */
export function relId(el: Element, localName = "id"): string | null {
  for (const a of el.attributes) {
    if (
      a.localName === localName &&
      (a.prefix === "r" || (a.namespaceURI ?? "").includes("/relationships"))
    )
      return a.value;
  }
  return null;
}

export function attrNum(el: Element, localName: string): number | null {
  const v = attr(el, localName);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Relationships of a part: id → resolved target path (+ type). */
export interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

function dirOf(partPath: string): string {
  const i = partPath.lastIndexOf("/");
  return i < 0 ? "" : partPath.slice(0, i);
}

/** Resolve `target` (relative to `partPath`'s directory, or absolute with a
 *  leading slash) to a normalized package path. */
export function resolveTarget(partPath: string, target: string): string {
  const base = target.startsWith("/")
    ? []
    : dirOf(partPath).split("/").filter(Boolean);
  const out = [...base];
  for (const seg of target.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

export function relsFor(
  pkg: OoxmlPackage,
  partPath: string,
): ReadonlyMap<string, Relationship> {
  const dir = dirOf(partPath);
  const name = partPath.slice(dir.length === 0 ? 0 : dir.length + 1);
  const relsPath = `${dir.length === 0 ? "" : `${dir}/`}_rels/${name}.rels`;
  const doc = partXml(pkg, relsPath);
  const map = new Map<string, Relationship>();
  if (doc === null) return map;
  for (const rel of descendants(doc, "Relationship")) {
    const id = attr(rel, "Id");
    const type = attr(rel, "Type") ?? "";
    const target = attr(rel, "Target");
    if (id === null || target === null) continue;
    const external = attr(rel, "TargetMode") === "External";
    map.set(id, {
      id,
      type: type.slice(type.lastIndexOf("/") + 1),
      target: external ? target : resolveTarget(partPath, target),
      external,
    });
  }
  return map;
}

/** Decode the five XML entities plus numeric references in text that came
 *  from a regex walk rather than the DOM. */
export function decodeEntities(s: string): string {
  return s.replace(
    /&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi,
    (m, e: string) => {
      const lower = e.toLowerCase();
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "amp") return "&";
      if (lower === "quot") return '"';
      if (lower === "apos") return "'";
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    },
  );
}
