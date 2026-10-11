import { describe, expect, it } from "vitest";
import { parseAndValidateClaimOutput } from "./claim-output-validator.js";

const ALLOWED_ENTITIES = new Set([
  "herta.person.prime",
  "herta.form.doll",
  "herta.place.space_station",
  "faction.genius_society",
]);
const ALLOWED_CHUNKS = new Set(["chunk:1", "chunk:2"]);
const ALLOWED_PREDICATES = new Set([
  "alias_of",
  "manifestation_of",
  "controls_or_uses",
  "owns",
  "member_of",
  "associated_with",
  "created",
  "authored",
  "member_number",
]);

describe("parseAndValidateClaimOutput — happy path", () => {
  it("accepts a literal-valued claim", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "member_number",
          value: "#83",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
          rationale: "explicit text",
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0]?.value).toBe("#83");
  });

  it("accepts an entity-valued claim", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "member_of",
          object_entity_id: "faction.genius_society",
          evidence_chunk_ids: ["chunk:1", "chunk:2"],
          confidence: 0.85,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.objectEntityId).toBe("faction.genius_society");
  });
});

describe("parseAndValidateClaimOutput — rejection paths", () => {
  it("rejects unknown subject entity id", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "unknown.thing",
          predicate: "member_number",
          value: "#83",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/subject/);
  });

  it("rejects ambiguous subject entity", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.name.ambiguous",
          predicate: "member_number",
          value: "#83",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      new Set([...ALLOWED_ENTITIES, "herta.name.ambiguous"]),
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/ambiguous/i);
  });

  it("rejects unknown evidence chunk id", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "member_number",
          value: "#83",
          evidence_chunk_ids: ["chunk:fake"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/chunk/);
  });

  it("rejects out-of-range confidence", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "member_number",
          value: "#83",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 1.5,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/confidence/);
  });

  it("rejects claim with neither value nor object_entity_id", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "member_number",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/value|object/);
  });

  it("rejects malformed top-level JSON", () => {
    const result = parseAndValidateClaimOutput(
      "not json",
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/parse/i);
  });

  it("rejects malformed predicate (empty / non-string)", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "",
          value: "#83",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/predicate/);
  });

  it("rejects predicate not in allowlist", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "related_to",
          object_entity_id: "faction.genius_society",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/unknown predicate/i);
  });

  it("rejects a self-referential entity claim (subject === object)", () => {
    const raw = JSON.stringify({
      claims: [
        {
          subject_entity_id: "herta.person.prime",
          predicate: "member_of",
          object_entity_id: "herta.person.prime",
          evidence_chunk_ids: ["chunk:1"],
          confidence: 0.9,
        },
      ],
    });
    const result = parseAndValidateClaimOutput(
      raw,
      ALLOWED_CHUNKS,
      ALLOWED_ENTITIES,
      ALLOWED_PREDICATES,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/self-reference/i);
  });
});
