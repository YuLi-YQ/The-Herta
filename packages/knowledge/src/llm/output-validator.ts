import {
  type CanonEntityId,
  HERTA_FORM_DOLL,
  HERTA_NAME_AMBIGUOUS,
  HERTA_PERSON_PRIME,
  HERTA_PLACE_SPACE_STATION,
  HERTA_WORK_MANUSCRIPT,
} from "../schema.js";

const ALLOWED_ENTITY_IDS = new Set<string>([
  HERTA_PERSON_PRIME,
  HERTA_FORM_DOLL,
  HERTA_PLACE_SPACE_STATION,
  HERTA_WORK_MANUSCRIPT,
  HERTA_NAME_AMBIGUOUS,
]);

export interface LlmAnnotatedMention {
  surface: string;
  referentEntityId: CanonEntityId;
  embodimentEntityId?: CanonEntityId;
  speakerEntityId?: CanonEntityId;
  confidence: number;
  rationale?: string;
}

export interface LlmAnnotatedChunk {
  chunkId: string;
  mentions: LlmAnnotatedMention[];
  isHertaVoiceEvidence: boolean;
}

export interface RejectedAnnotation {
  chunkId?: string;
  reason: string;
}

export interface ValidationResult {
  accepted: LlmAnnotatedChunk[];
  rejected: RejectedAnnotation[];
}

interface RawMention {
  surface?: unknown;
  referent_entity_id?: unknown;
  embodiment_entity_id?: unknown;
  speaker_entity_id?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

interface RawChunk {
  chunk_id?: unknown;
  mentions?: unknown;
  is_herta_voice_evidence?: unknown;
}

interface RawResponse {
  chunks?: unknown;
}

export function parseAndValidateLlmOutput(
  rawJson: string,
  allowedChunkIds: ReadonlySet<string>,
): ValidationResult {
  let parsed: RawResponse;
  try {
    parsed = JSON.parse(rawJson) as RawResponse;
  } catch (err) {
    return {
      accepted: [],
      rejected: [
        { reason: `json parse error: ${(err as Error).message.slice(0, 80)}` },
      ],
    };
  }
  const accepted: LlmAnnotatedChunk[] = [];
  const rejected: RejectedAnnotation[] = [];
  if (!Array.isArray(parsed.chunks)) {
    return {
      accepted,
      rejected: [{ reason: "missing top-level chunks array" }],
    };
  }
  for (const item of parsed.chunks) {
    const validated = validateChunk(item as RawChunk, allowedChunkIds);
    if ("accepted" in validated) accepted.push(validated.accepted);
    else rejected.push(validated.rejected);
  }
  return { accepted, rejected };
}

function validateChunk(
  raw: RawChunk,
  allowedChunkIds: ReadonlySet<string>,
): { accepted: LlmAnnotatedChunk } | { rejected: RejectedAnnotation } {
  if (typeof raw.chunk_id !== "string") {
    return { rejected: { reason: "missing chunk_id (not a string)" } };
  }
  if (!allowedChunkIds.has(raw.chunk_id)) {
    return {
      rejected: {
        chunkId: raw.chunk_id,
        reason: `unknown chunk_id: ${raw.chunk_id}`,
      },
    };
  }
  if (!Array.isArray(raw.mentions)) {
    return {
      rejected: { chunkId: raw.chunk_id, reason: "mentions is not an array" },
    };
  }
  const mentions: LlmAnnotatedMention[] = [];
  for (const m of raw.mentions) {
    const valid = validateMention(m as RawMention);
    if ("accepted" in valid) mentions.push(valid.accepted);
    else
      return {
        rejected: { chunkId: raw.chunk_id, reason: valid.rejected },
      };
  }
  return {
    accepted: {
      chunkId: raw.chunk_id,
      mentions,
      isHertaVoiceEvidence: raw.is_herta_voice_evidence === true,
    },
  };
}

function validateMention(
  raw: RawMention,
): { accepted: LlmAnnotatedMention } | { rejected: string } {
  if (typeof raw.surface !== "string")
    return { rejected: "mention.surface not a string" };
  if (typeof raw.referent_entity_id !== "string") {
    return { rejected: "mention.referent_entity_id not a string" };
  }
  if (!ALLOWED_ENTITY_IDS.has(raw.referent_entity_id)) {
    return { rejected: `unknown entity id: ${raw.referent_entity_id}` };
  }
  if (
    typeof raw.confidence !== "number" ||
    raw.confidence < 0 ||
    raw.confidence > 1
  ) {
    return {
      rejected: `confidence out of [0,1] or not a number: ${String(raw.confidence)}`,
    };
  }
  if (
    raw.embodiment_entity_id !== undefined &&
    (typeof raw.embodiment_entity_id !== "string" ||
      !ALLOWED_ENTITY_IDS.has(raw.embodiment_entity_id))
  ) {
    return {
      rejected: `unknown embodiment entity: ${String(raw.embodiment_entity_id)}`,
    };
  }
  if (
    raw.speaker_entity_id !== undefined &&
    (typeof raw.speaker_entity_id !== "string" ||
      !ALLOWED_ENTITY_IDS.has(raw.speaker_entity_id))
  ) {
    return {
      rejected: `unknown speaker entity: ${String(raw.speaker_entity_id)}`,
    };
  }
  return {
    accepted: {
      surface: raw.surface,
      referentEntityId: raw.referent_entity_id,
      embodimentEntityId:
        typeof raw.embodiment_entity_id === "string"
          ? raw.embodiment_entity_id
          : undefined,
      speakerEntityId:
        typeof raw.speaker_entity_id === "string"
          ? raw.speaker_entity_id
          : undefined,
      confidence: raw.confidence,
      rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
    },
  };
}
