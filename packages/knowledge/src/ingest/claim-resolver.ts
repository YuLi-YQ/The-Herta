import type { CanonClaim, ClaimResolution, ProposedClaim } from "../schema.js";

export function resolveClaim(
  candidate: ProposedClaim,
  existingActiveClaims: ReadonlyArray<CanonClaim>,
): ClaimResolution {
  const sameKey = existingActiveClaims.filter(
    (c) =>
      c.subjectEntityId === candidate.subjectEntityId &&
      c.predicate === candidate.predicate,
  );
  if (sameKey.length === 0) return { kind: "add" };

  // Look for an exact match on value/object first.
  const exact = sameKey.find((c) => sameValueOrObject(c, candidate));
  if (exact !== undefined) {
    const merged = mergeChunkIds(
      exact.evidenceChunkIds,
      candidate.evidenceChunkIds,
    );
    if (merged.length === exact.evidenceChunkIds.length) {
      return { kind: "noop", existingClaimId: exact.id };
    }
    return {
      kind: "merge_evidence",
      existingClaimId: exact.id,
      mergedChunkIds: merged,
      newConfidence: Math.max(exact.confidence, candidate.confidence),
    };
  }

  // Different value/object for the same (subject, predicate). Conflict.
  // Prefer naming the highest-confidence existing claim as the conflict.
  const conflict = sameKey.reduce((a, b) =>
    b.confidence > a.confidence ? b : a,
  );
  return {
    kind: "needs_review",
    conflictsWithClaimId: conflict.id,
    reason: `proposed ${describeRhs(candidate)} conflicts with existing ${describeRhs(conflict)} (${conflict.method}, conf ${conflict.confidence.toFixed(2)})`,
  };
}

function sameValueOrObject(c: CanonClaim, p: ProposedClaim): boolean {
  if (c.value !== undefined || p.value !== undefined) {
    return c.value === p.value;
  }
  return c.objectEntityId === p.objectEntityId;
}

function mergeChunkIds(
  existing: ReadonlyArray<string>,
  candidate: ReadonlyArray<string>,
): string[] {
  const set = new Set(existing);
  for (const id of candidate) set.add(id);
  return [...set].sort();
}

function describeRhs(c: { value?: string; objectEntityId?: string }): string {
  if (c.value !== undefined) return `value=${JSON.stringify(c.value)}`;
  if (c.objectEntityId !== undefined) return `object=${c.objectEntityId}`;
  return "value=null";
}
