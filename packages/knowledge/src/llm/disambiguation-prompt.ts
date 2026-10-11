import type { CanonDocumentKind } from "../schema.js";
import { stableStringify } from "../text-utils.js";
import type { DisambiguationBatchInput } from "./types.js";

export const DISAMBIGUATION_SYSTEM_PROMPT = `You are labeling local Star Rail canon chunks for a Herta-specific knowledge database.
Return strict json only. Do not invent facts. Use only the provided chunk and metadata.
For each input chunk, decide which Herta entity each "黑塔"-related surface refers to.
Output must follow the json schema shown in required_json_schema_example.`;

export interface DisambiguationChunkInput {
  chunkId: string;
  documentTitle: string;
  documentKind: CanonDocumentKind;
  sectionPath: ReadonlyArray<string>;
  speaker?: string;
  text: string;
}

export interface BuildDisambiguationRequestOptions {
  model: string;
  chunks: ReadonlyArray<DisambiguationChunkInput>;
}

const ENTITY_DEFINITIONS = {
  "herta.person.prime":
    "大黑塔/黑塔本人, Genius Society #83, the real (prime) Herta",
  "herta.form.doll":
    "小黑塔/黑塔人偶/playable Herta, remote doll manifestation",
  "herta.place.space_station": "空间站「黑塔」, the space station",
  "herta.work.manuscript": "黑塔的手稿, authored/attributed work",
  "herta.name.ambiguous": "unresolved mention — use when uncertain",
} as const;

const SCHEMA_EXAMPLE = {
  chunks: [
    {
      chunk_id: "c...",
      mentions: [
        {
          surface: "黑塔",
          referent_entity_id: "herta.person.prime",
          embodiment_entity_id: "herta.form.doll",
          speaker_entity_id: "herta.person.prime",
          confidence: 0.86,
          rationale:
            "Speaker label is Herta in mission dialogue; scene implies remote doll manifestation.",
        },
      ],
      is_herta_voice_evidence: true,
    },
  ],
} as const;

export function buildDisambiguationRequest(
  opts: BuildDisambiguationRequestOptions,
): DisambiguationBatchInput {
  const userPayload = stableStringify({
    task: "disambiguate_herta_mentions",
    entity_definitions: ENTITY_DEFINITIONS,
    chunks: opts.chunks.map((c) => ({
      chunk_id: c.chunkId,
      document_title: c.documentTitle,
      document_kind: c.documentKind,
      section_path: c.sectionPath,
      ...(c.speaker !== undefined ? { speaker: c.speaker } : {}),
      text: c.text,
    })),
    required_json_schema_example: SCHEMA_EXAMPLE,
  });
  return {
    systemPrompt: DISAMBIGUATION_SYSTEM_PROMPT,
    userPayload,
    model: opts.model,
  };
}

// Stable JSON.stringify with sorted keys so identical input produces byte-identical output.
