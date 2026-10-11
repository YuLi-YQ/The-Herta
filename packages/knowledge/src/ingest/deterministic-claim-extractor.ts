import { createHash } from "node:crypto";
import {
  type CanonClaim,
  HERTA_NAME_AMBIGUOUS,
  type SeedEdge,
} from "../schema.js";

export interface ChunkSignal {
  chunkId: string;
  text: string;
  mentions: ReadonlyArray<{
    surface: string;
    referentEntityId: string;
    confidence: number;
    method: "deterministic" | "llm" | "human_review";
  }>;
}

export interface ClaimExtractorInput {
  now: string;
  seedEdges: ReadonlyArray<SeedEdge>;
  chunks: ReadonlyArray<ChunkSignal>;
}

const MEMBER_NUMBER_PATTERNS: ReadonlyArray<RegExp> = [
  /成员编号\s*#(\d+)/u,
  /#(\d+)\s*号成员/u,
  /天才俱乐部\s*#(\d+)/u,
];

const HIGH_CONFIDENCE_MENTION = 0.9;

export function extractDeterministicClaims(
  input: ClaimExtractorInput,
): CanonClaim[] {
  const out: CanonClaim[] = [];
  for (const edge of input.seedEdges) {
    out.push(seedEdgeToClaim(edge, input.now));
  }
  for (const chunk of input.chunks) {
    const memberClaim = extractMemberNumberClaim(chunk, input.now);
    if (memberClaim !== undefined) out.push(memberClaim);
  }
  return out;
}

function seedEdgeToClaim(edge: SeedEdge, now: string): CanonClaim {
  const id = stableId(
    "seed",
    edge.sourceEntityId,
    edge.relation,
    edge.targetEntityId,
  );
  return {
    id,
    subjectEntityId: edge.sourceEntityId,
    predicate: edge.relation,
    objectEntityId: edge.targetEntityId,
    evidenceChunkIds: [],
    confidence: 1.0,
    method: "deterministic",
    status: "active",
    rationale: edge.rationale,
    createdAt: now,
  };
}

function extractMemberNumberClaim(
  chunk: ChunkSignal,
  now: string,
): CanonClaim | undefined {
  let match: RegExpMatchArray | null = null;
  for (const re of MEMBER_NUMBER_PATTERNS) {
    match = chunk.text.match(re);
    if (match !== null) break;
  }
  if (match === null) return undefined;
  const numberStr = match[1];
  if (numberStr === undefined) return undefined;

  const subject = pickHighConfidencePersonMention(chunk);
  if (subject === undefined) return undefined;

  const value = `#${numberStr}`;
  const id = stableId("text", subject, "member_number", value, chunk.chunkId);
  return {
    id,
    subjectEntityId: subject,
    predicate: "member_number",
    value,
    evidenceChunkIds: [chunk.chunkId],
    confidence: 0.92,
    method: "deterministic",
    status: "active",
    rationale: `regex match: ${match[0]}`,
    createdAt: now,
  };
}

function pickHighConfidencePersonMention(
  chunk: ChunkSignal,
): string | undefined {
  for (const m of chunk.mentions) {
    if (m.referentEntityId === HERTA_NAME_AMBIGUOUS) continue;
    if (!m.referentEntityId.startsWith("herta.person.")) continue;
    if (m.confidence < HIGH_CONFIDENCE_MENTION) continue;
    return m.referentEntityId;
  }
  for (const m of chunk.mentions) {
    if (m.referentEntityId === HERTA_NAME_AMBIGUOUS) continue;
    if (!m.referentEntityId.startsWith("person.")) continue;
    if (m.confidence < HIGH_CONFIDENCE_MENTION) continue;
    return m.referentEntityId;
  }
  return undefined;
}

function stableId(...parts: ReadonlyArray<string>): string {
  const h = createHash("sha256").update(parts.join(" ")).digest("hex");
  return `claim:${parts[0]}:${h.slice(0, 24)}`;
}
