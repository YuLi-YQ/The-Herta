import type { CanonDocumentKind } from "../schema.js";
import { stableStringify } from "../text-utils.js";
import type { DisambiguationBatchInput } from "./types.js";

export const CLAIM_EXTRACTION_SYSTEM_PROMPT = `You are extracting evidence-backed canon claims from local Star Rail source chunks for a Herta knowledge database.
Return strict json only. Do not invent facts. Use only the provided chunk text and metadata.
Each claim must cite at least one chunk_id from the input batch in evidence_chunk_ids.
Each claim's subject_entity_id must be one of the known entity ids supplied.
Each claim's predicate must be one of the known predicates. If predicate_definitions is provided, use the predicate whose definition matches the asserted fact most closely; do not invent new predicates.
Output must follow the json schema shown in required_json_schema_example.`;

export interface ClaimChunkInput {
  chunkId: string;
  documentTitle: string;
  documentKind: CanonDocumentKind;
  sectionPath: ReadonlyArray<string>;
  speaker?: string;
  text: string;
  mentions: ReadonlyArray<{
    surface: string;
    referentEntityId: string;
  }>;
}

export interface BuildClaimExtractionRequestOptions {
  model: string;
  knownEntityIds: ReadonlyArray<string>;
  knownPredicates: ReadonlyArray<string>;
  predicateDefinitions?: Readonly<Record<string, string>>;
  chunks: ReadonlyArray<ClaimChunkInput>;
}

const SCHEMA_EXAMPLE = {
  claims: [
    {
      subject_entity_id: "herta.person.prime",
      predicate: "member_number",
      value: "#83",
      evidence_chunk_ids: ["chunk:..."],
      confidence: 0.92,
      rationale: "Text states '天才俱乐部#83'.",
    },
    {
      subject_entity_id: "herta.person.prime",
      predicate: "owns",
      object_entity_id: "herta.place.space_station",
      evidence_chunk_ids: ["chunk:..."],
      confidence: 0.8,
      rationale: "Text describes 黑塔 as the station's owner.",
    },
  ],
} as const;

export function buildClaimExtractionRequest(
  opts: BuildClaimExtractionRequestOptions,
): DisambiguationBatchInput {
  const userPayload = stableStringify({
    task: "extract_canon_claims",
    known_entity_ids: [...opts.knownEntityIds].sort(),
    known_predicates: [...opts.knownPredicates].sort(),
    ...(opts.predicateDefinitions !== undefined
      ? { predicate_definitions: opts.predicateDefinitions }
      : {}),
    chunks: opts.chunks.map((c) => ({
      chunk_id: c.chunkId,
      document_title: c.documentTitle,
      document_kind: c.documentKind,
      section_path: c.sectionPath,
      ...(c.speaker !== undefined ? { speaker: c.speaker } : {}),
      text: c.text,
      mentions: c.mentions.map((m) => ({
        surface: m.surface,
        referent_entity_id: m.referentEntityId,
      })),
    })),
    required_json_schema_example: SCHEMA_EXAMPLE,
  });
  return {
    systemPrompt: CLAIM_EXTRACTION_SYSTEM_PROMPT,
    userPayload,
    model: opts.model,
  };
}
