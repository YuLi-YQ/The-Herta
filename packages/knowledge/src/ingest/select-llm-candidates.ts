import { HERTA_NAME_AMBIGUOUS } from "../schema.js";
import type { LabelChunkResult } from "./deterministic-labeler.js";

const SPEAKER_CONFIDENCE_THRESHOLD = 0.85;

export function selectLlmCandidates(
  labels: ReadonlyArray<LabelChunkResult>,
  maxChunks: number,
): LabelChunkResult[] {
  const out: LabelChunkResult[] = [];
  for (const label of labels) {
    if (out.length >= maxChunks) break;
    if (isCandidate(label)) out.push(label);
  }
  return out;
}

function isCandidate(label: LabelChunkResult): boolean {
  for (const m of label.mentions) {
    if (m.referentEntityId === HERTA_NAME_AMBIGUOUS) return true;
  }
  if (label.isHertaVoiceEvidence) {
    for (const m of label.mentions) {
      if (m.surface === "黑塔" && m.confidence < SPEAKER_CONFIDENCE_THRESHOLD) {
        return true;
      }
    }
  }
  return false;
}
