import { createHash } from "node:crypto";
import type { ClaimResolution, ProposedClaim } from "../schema.js";
import type { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import { resolveClaim } from "./claim-resolver.js";

export interface ApplyClaimResolutionInput {
  store: SqliteKnowledgeStore;
  candidate: ProposedClaim;
  now: string;
}

export type ApplyClaimResolutionResult =
  | { kind: "add"; claimId: string }
  | { kind: "noop"; existingClaimId: string }
  | { kind: "merge_evidence"; claimId: string }
  | { kind: "needs_review"; claimId: string; conflictsWithClaimId?: string };

/**
 * Apply a `ProposedClaim` to the store via the resolver. Inserts/merges/flags
 * for review depending on what's already in the claims table.
 *
 * This orchestrator is for LLM-derived candidates: every newly inserted claim
 * is recorded with `method: "llm"`. Deterministic / human_review writers should
 * call `store.insertClaim` directly with the appropriate method.
 */
export function applyClaimResolution(
  input: ApplyClaimResolutionInput,
): ApplyClaimResolutionResult {
  const { store, candidate, now } = input;
  const existing = store.getActiveClaimsForKey(
    candidate.subjectEntityId,
    candidate.predicate,
  );
  const resolution: ClaimResolution = resolveClaim(candidate, existing);

  switch (resolution.kind) {
    case "add": {
      const id = stableClaimId("llm", candidate);
      store.insertClaim({
        id,
        subjectEntityId: candidate.subjectEntityId,
        predicate: candidate.predicate,
        objectEntityId: candidate.objectEntityId,
        value: candidate.value,
        evidenceChunkIds: candidate.evidenceChunkIds,
        confidence: candidate.confidence,
        method: "llm",
        status: "active",
        rationale: candidate.rationale,
        createdAt: now,
      });
      return { kind: "add", claimId: id };
    }
    case "noop": {
      return { kind: "noop", existingClaimId: resolution.existingClaimId };
    }
    case "merge_evidence": {
      store.updateClaimEvidence(
        resolution.existingClaimId,
        resolution.mergedChunkIds,
        resolution.newConfidence,
      );
      return { kind: "merge_evidence", claimId: resolution.existingClaimId };
    }
    case "needs_review": {
      const id = stableClaimId("llm-review", candidate);
      store.insertClaim({
        id,
        subjectEntityId: candidate.subjectEntityId,
        predicate: candidate.predicate,
        objectEntityId: candidate.objectEntityId,
        value: candidate.value,
        evidenceChunkIds: candidate.evidenceChunkIds,
        confidence: candidate.confidence,
        method: "llm",
        status: "needs_review",
        rationale: resolution.reason,
        createdAt: now,
        supersedesClaimId: resolution.conflictsWithClaimId,
      });
      return {
        kind: "needs_review",
        claimId: id,
        conflictsWithClaimId: resolution.conflictsWithClaimId,
      };
    }
  }
}

function stableClaimId(prefix: string, c: ProposedClaim): string {
  // Use a NUL separator so empty fields and fields containing spaces can't
  // collide (e.g., predicate="P", value=" " vs predicate="P ", value="").
  const key = [
    prefix,
    c.subjectEntityId,
    c.predicate,
    c.objectEntityId ?? "",
    c.value ?? "",
  ].join("\x00");
  const h = createHash("sha256").update(key).digest("hex");
  return `claim:${prefix}:${h.slice(0, 24)}`;
}
