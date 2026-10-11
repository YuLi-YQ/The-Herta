import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";

export interface SceneTurn {
  chunkId: string;
  ordinal: number;
  /** Stable entity id when the speaker was resolved by the ingest pass. */
  speakerEntityId: string | null;
  /** Canonical name from `entities.canonical_name`, when resolved. */
  speakerName: string | null;
  /** Raw surface form parsed from the source (e.g. "黑塔" or "????"). */
  speakerSurface: string | null;
  text: string;
  /**
   * True when the line is the target-speaker themselves. Convenience flag
   * so consumers (renderers, prompts) can highlight Herta's turns without
   * comparing entity ids inline.
   */
  isTarget: boolean;
}

export interface Scene {
  documentId: string;
  documentTitle: string;
  documentPath: string;
  /** Distinct addressee/non-target speakers appearing alongside the target. */
  otherSpeakers: string[];
  /** Count of target-speaker turns in this scene. */
  targetTurnCount: number;
  turns: SceneTurn[];
}

export interface ExtractScenesOpts {
  /** Entity id whose conversations we want (default: HERTA_PERSON_PRIME). */
  targetEntityId: string;
  /**
   * Drop scenes that don't have at least this many target turns. Default 1
   * — any document with at least one target line counts as a scene.
   */
  minTargetTurns?: number;
  /**
   * Drop scenes shorter than this total turn count. Default 2 — single-
   * utterance docs are not "conversations".
   */
  minTurns?: number;
  /**
   * Optional cap: extract at most this many scenes (sorted by doc id for
   * determinism). Default: unbounded.
   */
  limit?: number;
}

/**
 * Walk every document containing at least one `targetEntityId` chunk and
 * emit a {@link Scene} per document — the full ordinal-ordered turn
 * stream including the other characters' lines around Herta's. Use cases:
 * offline curation of in-character "interaction memories", training-set
 * extraction, debugging the ingest's speaker attribution.
 *
 * Each scene is one document. We don't slice sub-windows; the ingest
 * already chunks by document and most canon docs are scene-sized. If a
 * doc is unusually long, downstream consumers can window it themselves.
 *
 * Pure-ish: depends only on the store reads, no time / no LLM / no I/O.
 * Output order is determined by `documents.id` for reproducibility.
 */
export function extractHertaScenes(
  store: SqliteKnowledgeStore,
  opts: ExtractScenesOpts,
): Scene[] {
  const minTargetTurns = opts.minTargetTurns ?? 1;
  const minTurns = opts.minTurns ?? 2;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  const docs = store.listDocsContainingSpeakerChunks(opts.targetEntityId);
  const scenes: Scene[] = [];

  for (const doc of docs) {
    if (scenes.length >= limit) break;
    const meta = store.getDocumentMeta(doc.id);
    if (meta === null) continue;
    const rawChunks = store.listAllChunksInDocWithSpeakers(doc.id);
    if (rawChunks.length < minTurns) continue;

    const turns: SceneTurn[] = rawChunks.map((c) => ({
      chunkId: c.chunkId,
      ordinal: c.ordinal,
      speakerEntityId: c.speakerEntityId,
      speakerName: c.speakerName,
      speakerSurface: c.speakerSurface,
      text: c.text,
      isTarget: c.speakerEntityId === opts.targetEntityId,
    }));

    const targetTurnCount = turns.reduce((n, t) => (t.isTarget ? n + 1 : n), 0);
    if (targetTurnCount < minTargetTurns) continue;

    const otherSpeakers = Array.from(
      new Set(
        turns
          .filter((t) => !t.isTarget)
          .map((t) => t.speakerName ?? t.speakerSurface)
          .filter((s): s is string => s !== null && s.length > 0),
      ),
    ).sort();

    scenes.push({
      documentId: meta.id,
      documentTitle: meta.title,
      documentPath: meta.path,
      otherSpeakers,
      targetTurnCount,
      turns,
    });
  }

  return scenes;
}
