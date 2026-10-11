import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CN↔EN terminology alignment over the game's community-extracted TextMaps
 * (EN interaction-language slice 1, 2026-07-14). The TextMap files are flat
 * `hash → string` JSON maps; every language file shares the SAME hash keys,
 * so a CN line's key indexes its exact official EN localization. This is
 * the evidence source for the curated glossary in `canonical-terms.ts` —
 * official translations, never hand-guessed ones.
 *
 * The maps live under `data/textmap/` (gitignored with the rest of the
 * canon corpus — large, derived, not redistributable). Offline dev tooling
 * only: nothing at runtime loads a TextMap.
 */

export const TEXTMAP_CN_FILENAME = "TextMapCHS.json";
export const TEXTMAP_EN_FILENAME = "TextMapEN.json";
export const DEFAULT_TEXTMAP_DIR_RELATIVE = "data/textmap";

export interface AlignedTerm {
  /** The shared TextMap hash key — cite this as evidence for a glossary entry. */
  readonly hash: string;
  readonly cn: string;
  /** Missing when the EN map lacks the key (a handful of CN-only rows exist). */
  readonly en?: string;
}

export interface GlossarySearchOptions {
  /** Maximum hits returned (default 10). */
  readonly limit?: number;
  /** Full-string equality instead of substring containment. */
  readonly exact?: boolean;
  /** Which language side the query matches against (default "cn"). */
  readonly side?: "cn" | "en";
}

/** A TextMap is a flat hash→string JSON object; anything else is a corrupt
 *  or wrong file and deserves a loud failure over a silent empty result. */
export function loadTextMap(path: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`not a TextMap (expected a JSON object): ${path}`);
  }
  return parsed as Record<string, string>;
}

export function defaultTextMapDir(workspaceRoot: string): string {
  return join(workspaceRoot, DEFAULT_TEXTMAP_DIR_RELATIVE);
}

/**
 * Search one side of the aligned maps and return CN/EN pairs, shortest
 * matched line first — for a term query the shortest hit is almost always
 * the canonical name entry (menus, character names), with dialogue usages
 * after it. Deterministic: ties break on the hash key.
 */
export function searchAlignedTerms(
  cnMap: Record<string, string>,
  enMap: Record<string, string>,
  query: string,
  opts: GlossarySearchOptions = {},
): AlignedTerm[] {
  const limit = opts.limit ?? 10;
  const side = opts.side ?? "cn";
  const haystack = side === "cn" ? cnMap : enMap;
  const matches = side === "en" && !opts.exact ? query.toLowerCase() : query;
  const hits: { hash: string; text: string }[] = [];
  for (const [hash, text] of Object.entries(haystack)) {
    if (typeof text !== "string" || text.length === 0) continue;
    const matched = opts.exact
      ? text === query
      : side === "en"
        ? text.toLowerCase().includes(matches)
        : text.includes(query);
    if (matched) hits.push({ hash, text });
  }
  hits.sort(
    (a, b) => a.text.length - b.text.length || (a.hash < b.hash ? -1 : 1),
  );
  return hits.slice(0, limit).map(({ hash }) => ({
    hash,
    cn: cnMap[hash] ?? "",
    en: enMap[hash],
  }));
}
