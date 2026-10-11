import { HERTA_PERSON_PRIME } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { alignChunk, buildAlignmentIndex } from "./align-translations.js";

export interface RunAlignPassOptions {
  store: SqliteKnowledgeStore;
  /** The CN TextMap (hash → line) — the alignment key space. */
  cnMap: Record<string, string>;
  /** The target-language TextMap sharing the CN map's hashes. */
  targetMap: Record<string, string>;
  /** Language tag written to the translation rows (default "en"). */
  lang?: string;
  /** Speaker whose stratified chunks get aligned. Defaults to Herta. */
  speakerEntityId?: string;
  /** Injectable clock for deterministic test timestamps. */
  now?: () => Date;
}

export interface RunAlignPassResult {
  chunksSeen: number;
  aligned: number;
  byMatchKind: { exact: number; normalized: number };
  /** CN text matched no TextMap line (wiki-composited text, gender forks). */
  unmatched: string[];
  /** CN line matched but the target map lacks the hash. */
  noTargetLine: string[];
}

/**
 * Alignment pass (EN interaction slice 2): resolve every stratified chunk
 * of the speaker to its official localized line and upsert
 * `chunk_translations` rows. Deterministic and offline — no LLM, no
 * network; the only inputs are the store and the two TextMaps. Idempotent:
 * re-running overwrites rows in place, so a corpus/TextMap refresh is just
 * "run it again".
 */
export function runAlignPass(opts: RunAlignPassOptions): RunAlignPassResult {
  const { store } = opts;
  const lang = opts.lang ?? "en";
  const speakerId = opts.speakerEntityId ?? HERTA_PERSON_PRIME;
  const clock = opts.now ?? (() => new Date());

  const index = buildAlignmentIndex(opts.cnMap);
  const chunks = store.listStratifiedChunkTexts(speakerId);

  const result: RunAlignPassResult = {
    chunksSeen: chunks.length,
    aligned: 0,
    byMatchKind: { exact: 0, normalized: 0 },
    unmatched: [],
    noTargetLine: [],
  };
  for (const chunk of chunks) {
    const outcome = alignChunk(
      chunk,
      index,
      opts.targetMap,
      lang,
      clock().toISOString(),
    );
    if (outcome.kind === "aligned") {
      store.upsertChunkTranslation(outcome.translation);
      result.aligned += 1;
      result.byMatchKind[outcome.translation.matchKind] += 1;
    } else if (outcome.kind === "unmatched") {
      result.unmatched.push(outcome.chunkId);
    } else {
      result.noTargetLine.push(outcome.chunkId);
    }
  }
  return result;
}
