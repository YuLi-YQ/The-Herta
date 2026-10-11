import type { ChunkTranslation } from "../schema.js";

/**
 * TextMap alignment for stratified voice chunks (EN interaction slice 2,
 * 2026-07-14). Resolves each CN chunk to its OFFICIAL localized line by
 * looking the CN text up in the aligned TextMaps (CN line → shared hash →
 * localized line) — the same evidence chain the glossary uses, applied to
 * whole exemplars. The CN addressee/mood stratification stays authoritative:
 * a translation row never re-classifies, it only re-words.
 *
 * Two match tiers, measured on the real corpus (2026-07-14: 1173 Herta
 * chunks → 88% exact, +9% normalized, 97.2% total):
 *  - "exact"      — the chunk text IS a TextMap line (after trim).
 *  - "normalized" — equal after stripping the variance the wiki corpus
 *    introduces: whitespace, markup, CJK/latin punctuation, and the
 *    {NICKNAME} player-name placeholder. Normalization is matching-only;
 *    the stored text is always the raw official line.
 *
 * Bumps when the normalization changes — re-running with a higher version
 * is the signal to re-align (rows are idempotently upserted).
 */
export const ALIGN_NORMALIZATION_VERSION = 1 as const;

/** Strip the variance that separates wiki-corpus text from TextMap lines.
 *  Matching-only — never applied to stored output. */
export function normalizeForAlignment(s: string): string {
  return (
    s
      // The TextMap writes the player name as a template; the wiki corpus
      // renders a concrete alias. Both collapse to the same token.
      .replace(/\{NICKNAME\}/g, "开拓者")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "")
      .replace(
        /[「」『』""''【】《》〈〉…。，！？：；、·—\-~～()（）.!?,:;'"]/g,
        "",
      )
  );
}

export interface AlignmentIndex {
  /** trimmed CN line → hash (first occurrence wins; duplicates are
   *  identical strings, so any witness hash is equally valid). */
  readonly exact: ReadonlyMap<string, string>;
  /** normalized CN line → hash. */
  readonly normalized: ReadonlyMap<string, string>;
}

/** One-time index over the CN TextMap (~440k entries, a few seconds). */
export function buildAlignmentIndex(
  cnMap: Record<string, string>,
): AlignmentIndex {
  const exact = new Map<string, string>();
  const normalized = new Map<string, string>();
  for (const [hash, text] of Object.entries(cnMap)) {
    if (typeof text !== "string" || text.length === 0) continue;
    if (!exact.has(text)) exact.set(text, hash);
    const n = normalizeForAlignment(text);
    if (n.length > 0 && !normalized.has(n)) normalized.set(n, hash);
  }
  return { exact, normalized };
}

export interface AlignChunkInput {
  readonly chunkId: string;
  /** The chunk's CN text as ingested. */
  readonly text: string;
}

export type AlignOutcome =
  | { readonly kind: "aligned"; readonly translation: ChunkTranslation }
  | {
      readonly kind: "unmatched" | "no_target_line";
      readonly chunkId: string;
    };

/**
 * Resolve one chunk against the index and the target-language map.
 * `no_target_line` = the CN line matched but the target map lacks the hash
 * (a handful of CN-only rows exist) — kept distinct from "unmatched" so
 * coverage reports don't blame the normalizer for a source-data gap.
 */
export function alignChunk(
  chunk: AlignChunkInput,
  index: AlignmentIndex,
  targetMap: Record<string, string>,
  lang: string,
  alignedAt: string,
): AlignOutcome {
  const trimmed = chunk.text.trim();
  let matchKind: ChunkTranslation["matchKind"] = "exact";
  let hash = index.exact.get(trimmed);
  if (hash === undefined) {
    matchKind = "normalized";
    hash = index.normalized.get(normalizeForAlignment(trimmed));
  }
  if (hash === undefined) return { kind: "unmatched", chunkId: chunk.chunkId };
  const text = targetMap[hash];
  if (text === undefined || text.length === 0) {
    return { kind: "no_target_line", chunkId: chunk.chunkId };
  }
  return {
    kind: "aligned",
    translation: {
      chunkId: chunk.chunkId,
      lang,
      text,
      textmapHash: hash,
      matchKind,
      alignedAt,
    },
  };
}
