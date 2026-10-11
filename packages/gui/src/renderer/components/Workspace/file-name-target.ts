/**
 * Locate the file name inside a localized row body (ADR 0050 §1). The
 * digest carries the path verbatim while the verb localizes around it, so
 * a substring split is exact when it works — and when it doesn't (a
 * projection or localization change reworded the arg), the row must
 * degrade to plain text, never to a broken control. Last occurrence on
 * purpose: a verb could legally contain the arg's characters, the tail
 * position cannot.
 */
export function splitBodyAtPath(
  body: string,
  path: string,
): {
  readonly before: string;
  readonly name: string;
  readonly after: string;
} | null {
  if (path.length === 0) return null;
  const idx = body.lastIndexOf(path);
  if (idx < 0) return null;
  return {
    before: body.slice(0, idx),
    name: path,
    after: body.slice(idx + path.length),
  };
}

/**
 * A finding cite parsed for the viewer (ADR 0050 v1.5): `path:12` /
 * `path:12-30` anchor to those lines; a bare path opens plain. Null for
 * anything that doesn't look like a cite — the row then renders it as
 * text, never as a broken control.
 */
export function parseCite(cite: string): {
  readonly path: string;
  readonly anchor?: { readonly from: number; readonly to: number };
} | null {
  const trimmed = cite.trim();
  if (trimmed.length === 0) return null;
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const from = Number.parseInt(m[2], 10);
    const to = m[3] !== undefined ? Number.parseInt(m[3], 10) : from;
    if (from > 0 && to >= from) {
      return { path: m[1], anchor: { from, to } };
    }
  }
  // A bare relative path (no drive-letter shapes — those carry a colon and
  // land in the branch above with a bogus "line", which the guard rejects).
  if (!trimmed.includes(":")) return { path: trimmed };
  return null;
}

/**
 * An op row's viewer target from its digest arg (ADR 0050 v1.5). Most
 * args are plain paths; an excerpt read's arg carries its range
 * ("a.ts:2-8"), which must open the file AT those lines — never be sent
 * to the reader as a literal path (found live, 2026-08-31). `name` stays
 * the verbatim arg when a range splits off — it is what the row displays.
 */
export function opTarget(arg: string): {
  readonly path: string;
  readonly name?: string;
  readonly anchor?: { readonly from: number; readonly to: number };
} {
  const parsed = parseCite(arg);
  if (parsed === null || parsed.anchor === undefined) return { path: arg };
  return { path: parsed.path, name: arg, anchor: parsed.anchor };
}

/**
 * Segment `text` around the FIRST occurrence of each target string,
 * scanning left to right without overlap (ADR 0050 v1.5) — the shape a
 * finding row's `claim — cite, cite` and the marker detail's
 * `↳ 改动文件: a.ts, b.ts` both have. Targets that don't occur are
 * skipped; a text with no hits returns one plain segment.
 */
export function segmentByTargets(
  text: string,
  targets: readonly string[],
): ReadonlyArray<
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "target"; readonly text: string; readonly index: number }
> {
  const hits: Array<{ at: number; len: number; index: number }> = [];
  let cursor = 0;
  // Find each target's first occurrence at/after the previous hit's end —
  // preserves document order and prevents overlaps when one target is a
  // substring of another's tail.
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i] as string;
    if (t.length === 0) continue;
    const at = text.indexOf(t, cursor);
    if (at < 0) continue;
    hits.push({ at, len: t.length, index: i });
    cursor = at + t.length;
  }
  if (hits.length === 0) return [{ kind: "text", text }];
  const out: Array<
    | { kind: "text"; text: string }
    | { kind: "target"; text: string; index: number }
  > = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at > pos) out.push({ kind: "text", text: text.slice(pos, h.at) });
    out.push({
      kind: "target",
      text: text.slice(h.at, h.at + h.len),
      index: h.index,
    });
    pos = h.at + h.len;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}
