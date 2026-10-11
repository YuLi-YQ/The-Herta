import { describe, expect, it } from "vitest";
import type { CanonClaim, ProposedClaim } from "../schema.js";
import { resolveClaim } from "./claim-resolver.js";

const NOW = "2026-05-06T00:00:00.000Z";

function existingClaim(over: Partial<CanonClaim> = {}): CanonClaim {
  return {
    id: "claim:existing:1",
    subjectEntityId: "herta.person.prime",
    predicate: "member_number",
    value: "#83",
    evidenceChunkIds: ["chunk:a"],
    confidence: 0.9,
    method: "deterministic",
    status: "active",
    createdAt: NOW,
    ...over,
  };
}

function proposed(over: Partial<ProposedClaim> = {}): ProposedClaim {
  return {
    subjectEntityId: "herta.person.prime",
    predicate: "member_number",
    value: "#83",
    evidenceChunkIds: ["chunk:b"],
    confidence: 0.85,
    ...over,
  };
}

describe("resolveClaim — ADD", () => {
  it("returns add when no existing claim matches subject+predicate", () => {
    const r = resolveClaim(proposed(), []);
    expect(r.kind).toBe("add");
  });

  it("returns add when existing claim has different predicate", () => {
    const r = resolveClaim(proposed(), [
      existingClaim({ id: "x", predicate: "member_of" }),
    ]);
    expect(r.kind).toBe("add");
  });
});

describe("resolveClaim — NOOP / MERGE_EVIDENCE", () => {
  it("returns noop when candidate's evidence is already covered", () => {
    const ex = existingClaim({ evidenceChunkIds: ["chunk:b"] });
    const r = resolveClaim(proposed({ evidenceChunkIds: ["chunk:b"] }), [ex]);
    expect(r.kind).toBe("noop");
    if (r.kind === "noop") expect(r.existingClaimId).toBe(ex.id);
  });

  it("returns merge_evidence when value matches but candidate adds a new chunk_id", () => {
    const ex = existingClaim({
      evidenceChunkIds: ["chunk:a"],
      confidence: 0.9,
    });
    const r = resolveClaim(
      proposed({ evidenceChunkIds: ["chunk:b"], confidence: 0.85 }),
      [ex],
    );
    expect(r.kind).toBe("merge_evidence");
    if (r.kind === "merge_evidence") {
      expect(r.existingClaimId).toBe(ex.id);
      expect([...r.mergedChunkIds].sort()).toEqual(["chunk:a", "chunk:b"]);
      expect(r.newConfidence).toBeCloseTo(0.9, 5); // max of existing & new
    }
  });

  it("entity-valued claims merge by objectEntityId match", () => {
    const ex = existingClaim({
      predicate: "member_of",
      value: undefined,
      objectEntityId: "faction.genius_society",
      evidenceChunkIds: [],
    });
    const r = resolveClaim(
      proposed({
        predicate: "member_of",
        value: undefined,
        objectEntityId: "faction.genius_society",
        evidenceChunkIds: ["chunk:b"],
      }),
      [ex],
    );
    expect(r.kind).toBe("merge_evidence");
  });
});

describe("resolveClaim — NEEDS_REVIEW", () => {
  it("conflicts when existing has different value", () => {
    const ex = existingClaim({ value: "#83" });
    const r = resolveClaim(proposed({ value: "#84" }), [ex]);
    expect(r.kind).toBe("needs_review");
    if (r.kind === "needs_review") {
      expect(r.conflictsWithClaimId).toBe(ex.id);
      expect(r.reason).toMatch(/value/i);
    }
  });

  it("conflicts when existing has different objectEntityId", () => {
    const ex = existingClaim({
      predicate: "member_of",
      value: undefined,
      objectEntityId: "faction.genius_society",
    });
    const r = resolveClaim(
      proposed({
        predicate: "member_of",
        value: undefined,
        objectEntityId: "faction.fake",
      }),
      [ex],
    );
    expect(r.kind).toBe("needs_review");
  });

  it("does not auto-OBSOLETE a deterministic claim", () => {
    // Even if proposed confidence > existing, deterministic stays canon.
    const ex = existingClaim({
      method: "deterministic",
      confidence: 0.92,
      value: "#83",
    });
    const r = resolveClaim(proposed({ value: "#84", confidence: 0.99 }), [ex]);
    expect(r.kind).toBe("needs_review");
  });
});
