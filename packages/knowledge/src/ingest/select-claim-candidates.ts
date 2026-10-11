import { HERTA_NAME_AMBIGUOUS } from "../schema.js";

export interface ClaimCandidateInput {
  chunkId: string;
  documentKind: string;
  isCanonFactCandidate: boolean;
  isHertaVoiceEvidence?: boolean;
  mentions: ReadonlyArray<{
    surface: string;
    referentEntityId: string;
    confidence: number;
  }>;
}

// Speaker-label confidence (0.85) is the lowest we accept for LLM claim
// candidates. Direct-surface prime mentions (0.99) easily clear this bar too.
const HIGH_CONFIDENCE_MENTION = 0.85;

const KIND_RANK: ReadonlyArray<string> = [
  "character_profile",
  "book_readable",
  "world_lore",
  "chronology",
  "simulated_universe",
  "mission_dialogue",
  "unknown",
];

function rankOf(kind: string): number {
  const i = KIND_RANK.indexOf(kind);
  return i === -1 ? KIND_RANK.length : i;
}

export function selectClaimCandidates(
  chunks: ReadonlyArray<ClaimCandidateInput>,
  maxCount: number,
): ClaimCandidateInput[] {
  const eligible: Array<{ idx: number; chunk: ClaimCandidateInput }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c === undefined) continue;
    if (!c.isCanonFactCandidate && !c.isHertaVoiceEvidence) continue;
    if (!hasUsablePersonMention(c)) continue;
    eligible.push({ idx: i, chunk: c });
  }
  eligible.sort((a, b) => {
    const ra = rankOf(a.chunk.documentKind);
    const rb = rankOf(b.chunk.documentKind);
    if (ra !== rb) return ra - rb;
    return a.idx - b.idx;
  });
  return eligible.slice(0, maxCount).map((e) => e.chunk);
}

function hasUsablePersonMention(c: ClaimCandidateInput): boolean {
  for (const m of c.mentions) {
    if (m.referentEntityId === HERTA_NAME_AMBIGUOUS) continue;
    if (m.confidence < HIGH_CONFIDENCE_MENTION) continue;
    if (
      m.referentEntityId.startsWith("herta.person.") ||
      m.referentEntityId.startsWith("person.")
    ) {
      return true;
    }
  }
  return false;
}
