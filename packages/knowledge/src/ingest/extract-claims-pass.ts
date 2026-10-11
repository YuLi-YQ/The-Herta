import { SEED_EDGES } from "../seed/entities.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import {
  type ChunkSignal,
  extractDeterministicClaims,
} from "./deterministic-claim-extractor.js";

export interface ExtractClaimsPassInput {
  store: SqliteKnowledgeStore;
  now: string;
}

export interface ExtractClaimsPassResult {
  seedClaimsWritten: number;
  textClaimsWritten: number;
  totalClaims: number;
}

export function runExtractClaimsPass(
  input: ExtractClaimsPassInput,
): ExtractClaimsPassResult {
  const { store, now } = input;

  const seedClaims = extractDeterministicClaims({
    now,
    seedEdges: SEED_EDGES,
    chunks: [],
  });

  const chunks: ChunkSignal[] = store.listChunkSignalsForClaims();
  const textClaims = extractDeterministicClaims({
    now,
    seedEdges: [],
    chunks,
  });

  for (const c of seedClaims) store.insertClaim(c);
  for (const c of textClaims) store.insertClaim(c);

  return {
    seedClaimsWritten: seedClaims.length,
    textClaimsWritten: textClaims.length,
    totalClaims: store.countClaims(),
  };
}
