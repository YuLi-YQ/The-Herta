import type { LlmAnnotatedChunk } from "../llm/output-validator.js";
import { type EntityMention, HERTA_NAME_AMBIGUOUS } from "../schema.js";

type MentionShape = Omit<EntityMention, "id" | "chunkId">;

const ACCEPT_THRESHOLD = 0.65;

export function applyLlmAnnotations(
  mentions: ReadonlyArray<MentionShape>,
  annot: LlmAnnotatedChunk,
): MentionShape[] {
  const result: MentionShape[] = mentions.map((m) => {
    const llmMatch = annot.mentions.find((lm) => lm.surface === m.surface);
    if (llmMatch === undefined) return m;
    return llmToMention(llmMatch, m);
  });
  // Append any LLM mentions that didn't match an existing surface.
  for (const lm of annot.mentions) {
    if (mentions.some((m) => m.surface === lm.surface)) continue;
    result.push(llmToMention(lm, undefined));
  }
  return result;
}

function llmToMention(
  llm: LlmAnnotatedChunk["mentions"][number],
  base: MentionShape | undefined,
): MentionShape {
  const lowConfidence = llm.confidence < ACCEPT_THRESHOLD;
  const referent = lowConfidence ? HERTA_NAME_AMBIGUOUS : llm.referentEntityId;
  return {
    surface: llm.surface,
    referentEntityId: referent,
    embodimentEntityId: llm.embodimentEntityId ?? base?.embodimentEntityId,
    speakerEntityId: llm.speakerEntityId ?? base?.speakerEntityId,
    pageSubjectEntityId: base?.pageSubjectEntityId,
    confidence: llm.confidence,
    method: "llm",
    rationale: llm.rationale ?? "LLM disambiguation.",
  };
}
