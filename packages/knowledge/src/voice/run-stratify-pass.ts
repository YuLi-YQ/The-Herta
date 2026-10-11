import { HERTA_PERSON_PRIME } from "../schema.js";
import { PERSON_TRAILBLAZER } from "../seed/entities.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { classifyAddressee, STRATIFY_CLASSIFIER_VERSION } from "./stratify.js";

export interface RunStratifyPassOptions {
  store: SqliteKnowledgeStore;
  /** Speaker to stratify. Defaults to {@link HERTA_PERSON_PRIME}. */
  speakerEntityId?: string;
  /** Injectable clock for deterministic test timestamps. */
  now?: () => Date;
  /**
   * Override classifier version written to each row. Test-only escape hatch
   * for verifying that bumping the version overwrites prior strata.
   */
  classifierVersion?: number;
}

export interface RunStratifyPassResult {
  chunksClassified: number;
  byClass: {
    player: number;
    other_named: number;
    self_narration: number;
    unknown: number;
  };
}

interface AliasRow {
  entityId: string;
  alias: string;
}

interface ChunkRow {
  id: string;
  documentId: string;
  text: string;
  speakerEntityId: string;
  docKind: string;
  docPath: string;
  pageSubjectEntityId: string | null;
}

/**
 * R0 deterministic stratifier. Walks every chunk where speaker = the
 * configured speaker entity, classifies each by addressee class via the
 * pure {@link classifyAddressee} heuristic, and upserts a row into
 * `voice_evidence_strata`. Idempotent: re-running with the same
 * `classifierVersion` overwrites prior rows in place.
 *
 * Excludes from the alias index:
 *  - the speaker itself (Herta would not address herself by alias);
 *  - the player (handled by Rule 2's hard-coded list);
 *  - ambiguous-sentinel entities (would otherwise spuriously match `黑塔`).
 */
export function runStratifyPass(
  opts: RunStratifyPassOptions,
): RunStratifyPassResult {
  const { store } = opts;
  const speakerId = opts.speakerEntityId ?? HERTA_PERSON_PRIME;
  const clock = opts.now ?? (() => new Date());
  const version = opts.classifierVersion ?? STRATIFY_CLASSIFIER_VERSION;

  // Build the alias index. Sort by (entityId, alias) so the "first hit
  // wins" rule in classifyAddressee is deterministic across runs.
  const aliasRows = store.rawAll<AliasRow>(
    `SELECT a.entity_id AS entityId, a.alias AS alias
     FROM aliases a
     JOIN entities e ON e.id = a.entity_id
     WHERE a.entity_id != ?
       AND a.entity_id != ?
       AND e.type != 'ambiguous'
     ORDER BY a.entity_id ASC, a.alias ASC`,
    speakerId,
    PERSON_TRAILBLAZER,
  );

  // Iterate every chunk where the speaker matches. Include the document
  // kind + page subject inline so we don't pay a per-chunk follow-up
  // query for the self_narration check.
  const chunkRows = store.rawAll<ChunkRow>(
    `SELECT c.id                       AS id,
            c.document_id              AS documentId,
            c.text                     AS text,
            c.speaker_entity_id        AS speakerEntityId,
            d.kind                     AS docKind,
            d.path                     AS docPath,
            d.page_subject_entity_id   AS pageSubjectEntityId
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.speaker_entity_id = ?
     ORDER BY c.id ASC`,
    speakerId,
  );

  const result: RunStratifyPassResult = {
    chunksClassified: 0,
    byClass: { player: 0, other_named: 0, self_narration: 0, unknown: 0 },
  };

  for (const row of chunkRows) {
    const otherEntityHits: Array<{ entityId: string; alias: string }> = [];
    for (const a of aliasRows) {
      if (row.text.includes(a.alias)) {
        otherEntityHits.push({ entityId: a.entityId, alias: a.alias });
      }
    }

    const decision = classifyAddressee({
      chunk: {
        id: row.id,
        text: row.text,
        speakerEntityId: row.speakerEntityId,
      },
      document: {
        id: row.documentId,
        kind: row.docKind as never,
        path: row.docPath,
        pageSubjectEntityId: row.pageSubjectEntityId ?? undefined,
      },
      otherEntityHits,
    });

    store.upsertVoiceEvidenceStratum({
      chunkId: row.id,
      speakerEntityId: row.speakerEntityId,
      addresseeClass: decision.addresseeClass,
      addresseeEntityId: decision.addresseeEntityId,
      classifierVersion: version,
      classifiedAt: clock().toISOString(),
    });

    result.chunksClassified += 1;
    result.byClass[decision.addresseeClass] += 1;
  }

  return result;
}
