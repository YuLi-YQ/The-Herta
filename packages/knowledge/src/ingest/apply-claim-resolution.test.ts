import { describe, expect, it } from "vitest";
import type { ProposedClaim } from "../schema.js";
import { mkTempKnowledgeDb } from "../testing/mk-temp-knowledge-db.js";
import {
  type ApplyClaimResolutionResult,
  applyClaimResolution,
} from "./apply-claim-resolution.js";

const NOW = "2026-05-06T00:00:00.000Z";

function proposed(over: Partial<ProposedClaim> = {}): ProposedClaim {
  return {
    subjectEntityId: "herta.person.prime",
    predicate: "member_number",
    value: "#83",
    evidenceChunkIds: ["chunk:b"],
    confidence: 0.85,
    rationale: "llm",
    ...over,
  };
}

describe("applyClaimResolution", () => {
  it("ADD inserts a new active LLM claim with deterministic id", () => {
    const h = mkTempKnowledgeDb();
    try {
      const r1: ApplyClaimResolutionResult = applyClaimResolution({
        store: h.store,
        candidate: proposed(),
        now: NOW,
      });
      expect(r1.kind).toBe("add");
      const claims = h.store.getClaimsBySubject("herta.person.prime");
      const added = claims.find((c) => c.predicate === "member_number");
      expect(added?.method).toBe("llm");
      expect(added?.status).toBe("active");
      expect(added?.evidenceChunkIds).toEqual(["chunk:b"]);

      // Re-running with same inputs is idempotent.
      const r2 = applyClaimResolution({
        store: h.store,
        candidate: proposed(),
        now: NOW,
      });
      expect(r2.kind).toBe("noop");
      expect(h.store.countClaims()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("MERGE_EVIDENCE updates existing claim's evidence and bumps confidence", () => {
    const h = mkTempKnowledgeDb();
    try {
      // Seed a deterministic claim with limited evidence.
      h.store.insertClaim({
        id: "claim:seed:m1",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: ["chunk:a"],
        confidence: 0.9,
        method: "deterministic",
        status: "active",
        createdAt: NOW,
      });
      const r = applyClaimResolution({
        store: h.store,
        candidate: proposed({
          evidenceChunkIds: ["chunk:b"],
          confidence: 0.92,
        }),
        now: NOW,
      });
      expect(r.kind).toBe("merge_evidence");
      const claims = h.store.getClaimsBySubject("herta.person.prime");
      const merged = claims.find((c) => c.id === "claim:seed:m1");
      expect([...(merged?.evidenceChunkIds ?? [])].sort()).toEqual([
        "chunk:a",
        "chunk:b",
      ]);
      expect(merged?.confidence).toBeCloseTo(0.92, 5);
      expect(h.store.countClaims()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("NEEDS_REVIEW inserts the candidate with status=needs_review and supersedes link", () => {
    const h = mkTempKnowledgeDb();
    try {
      h.store.insertClaim({
        id: "claim:seed:nr1",
        subjectEntityId: "herta.person.prime",
        predicate: "member_number",
        value: "#83",
        evidenceChunkIds: [],
        confidence: 0.92,
        method: "deterministic",
        status: "active",
        createdAt: NOW,
      });
      const r = applyClaimResolution({
        store: h.store,
        candidate: proposed({ value: "#84", confidence: 0.99 }),
        now: NOW,
      });
      expect(r.kind).toBe("needs_review");
      const claims = h.store.getClaimsBySubject("herta.person.prime");
      const review = claims.find((c) => c.status === "needs_review");
      expect(review?.value).toBe("#84");
      expect(review?.supersedesClaimId).toBe("claim:seed:nr1");
      // Original deterministic claim stays active.
      const original = claims.find((c) => c.id === "claim:seed:nr1");
      expect(original?.status).toBe("active");
    } finally {
      h.cleanup();
    }
  });
});
