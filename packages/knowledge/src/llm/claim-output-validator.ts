import {
  type CanonEntityId,
  HERTA_NAME_AMBIGUOUS,
  type ProposedClaim,
} from "../schema.js";

export interface RejectedClaim {
  index: number;
  reason: string;
}

export interface ClaimValidationResult {
  accepted: ProposedClaim[];
  rejected: RejectedClaim[];
}

interface RawClaim {
  subject_entity_id?: unknown;
  predicate?: unknown;
  object_entity_id?: unknown;
  value?: unknown;
  evidence_chunk_ids?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

interface RawResponse {
  claims?: unknown;
}

const PREDICATE_RE = /^[a-z][a-z0-9_]{0,31}$/;

export function parseAndValidateClaimOutput(
  rawJson: string,
  allowedChunkIds: ReadonlySet<string>,
  allowedEntityIds: ReadonlySet<string>,
  allowedPredicates: ReadonlySet<string>,
): ClaimValidationResult {
  let parsed: RawResponse;
  try {
    parsed = JSON.parse(rawJson) as RawResponse;
  } catch (err) {
    return {
      accepted: [],
      rejected: [
        {
          index: -1,
          reason: `json parse error: ${(err as Error).message.slice(0, 80)}`,
        },
      ],
    };
  }
  if (!Array.isArray(parsed.claims)) {
    return {
      accepted: [],
      rejected: [{ index: -1, reason: "missing top-level claims array" }],
    };
  }
  const accepted: ProposedClaim[] = [];
  const rejected: RejectedClaim[] = [];
  for (let i = 0; i < parsed.claims.length; i++) {
    const raw = parsed.claims[i] as RawClaim;
    const v = validateClaim(
      raw,
      allowedChunkIds,
      allowedEntityIds,
      allowedPredicates,
    );
    if ("accepted" in v) accepted.push(v.accepted);
    else rejected.push({ index: i, reason: v.rejected });
  }
  return { accepted, rejected };
}

function validateClaim(
  raw: RawClaim,
  allowedChunkIds: ReadonlySet<string>,
  allowedEntityIds: ReadonlySet<string>,
  allowedPredicates: ReadonlySet<string>,
): { accepted: ProposedClaim } | { rejected: string } {
  if (typeof raw.subject_entity_id !== "string") {
    return { rejected: "subject_entity_id not a string" };
  }
  if (raw.subject_entity_id === HERTA_NAME_AMBIGUOUS) {
    return { rejected: "subject is ambiguous (herta.name.ambiguous)" };
  }
  if (!allowedEntityIds.has(raw.subject_entity_id)) {
    return { rejected: `unknown subject entity: ${raw.subject_entity_id}` };
  }
  if (typeof raw.predicate !== "string" || !PREDICATE_RE.test(raw.predicate)) {
    return { rejected: `bad predicate: ${String(raw.predicate)}` };
  }
  if (!allowedPredicates.has(raw.predicate)) {
    return { rejected: `unknown predicate: ${raw.predicate}` };
  }
  const hasObject = typeof raw.object_entity_id === "string";
  const hasValue = typeof raw.value === "string" && raw.value.length > 0;
  if (!hasObject && !hasValue) {
    return { rejected: "claim has neither value nor object_entity_id" };
  }
  if (hasObject && !allowedEntityIds.has(raw.object_entity_id as string)) {
    return {
      rejected: `unknown object entity: ${String(raw.object_entity_id)}`,
    };
  }
  if (hasObject && raw.object_entity_id === HERTA_NAME_AMBIGUOUS) {
    return { rejected: "object is ambiguous (herta.name.ambiguous)" };
  }
  if (hasObject && raw.object_entity_id === raw.subject_entity_id) {
    return { rejected: "self-reference: subject equals object" };
  }
  if (
    typeof raw.confidence !== "number" ||
    raw.confidence < 0 ||
    raw.confidence > 1
  ) {
    return {
      rejected: `confidence out of [0,1]: ${String(raw.confidence)}`,
    };
  }
  if (!Array.isArray(raw.evidence_chunk_ids)) {
    return { rejected: "evidence_chunk_ids not an array" };
  }
  const evid: string[] = [];
  for (const eid of raw.evidence_chunk_ids) {
    if (typeof eid !== "string") {
      return { rejected: "evidence chunk id not a string" };
    }
    if (!allowedChunkIds.has(eid)) {
      return { rejected: `unknown chunk id in evidence: ${eid}` };
    }
    evid.push(eid);
  }
  if (evid.length === 0) {
    return { rejected: "evidence_chunk_ids must be non-empty" };
  }
  return {
    accepted: {
      subjectEntityId: raw.subject_entity_id as CanonEntityId,
      predicate: raw.predicate,
      objectEntityId: hasObject
        ? (raw.object_entity_id as CanonEntityId)
        : undefined,
      value: hasValue ? (raw.value as string) : undefined,
      evidenceChunkIds: evid,
      confidence: raw.confidence,
      rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
    },
  };
}
