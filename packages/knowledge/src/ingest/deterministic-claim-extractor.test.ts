import { describe, expect, it } from "vitest";
import {
  type ClaimExtractorInput,
  extractDeterministicClaims,
} from "./deterministic-claim-extractor.js";

const NOW = "2026-05-06T00:00:00.000Z";

describe("extractDeterministicClaims — seed lift", () => {
  it("lifts each seed edge to a deterministic claim with empty evidence", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [
        {
          sourceEntityId: "herta.person.prime",
          relation: "manifestation_of",
          targetEntityId: "herta.form.doll",
        },
        {
          sourceEntityId: "herta.person.prime",
          relation: "owns",
          targetEntityId: "herta.place.space_station",
        },
      ],
      chunks: [],
    };
    const claims = extractDeterministicClaims(input);
    expect(claims).toHaveLength(2);
    for (const c of claims) {
      expect(c.method).toBe("deterministic");
      expect(c.status).toBe("active");
      expect(c.confidence).toBe(1.0);
      expect(c.evidenceChunkIds).toEqual([]);
      expect(c.id.startsWith("claim:seed:")).toBe(true);
    }
    expect(claims[0]?.predicate).toBe("manifestation_of");
    expect(claims[0]?.objectEntityId).toBe("herta.form.doll");
  });

  it("produces stable IDs across runs (idempotent)", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [
        {
          sourceEntityId: "herta.person.prime",
          relation: "member_of",
          targetEntityId: "faction.genius_society",
        },
      ],
      chunks: [],
    };
    const a = extractDeterministicClaims(input);
    const b = extractDeterministicClaims({ ...input, now: "different" });
    expect(a[0]?.id).toBe(b[0]?.id);
  });
});

describe("extractDeterministicClaims — member_number pattern", () => {
  it("extracts a member_number claim from 成员编号#NN near a person mention", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [],
      chunks: [
        {
          chunkId: "chunk:1",
          text: "黑塔是天才俱乐部成员编号#83，专注模拟宇宙研究。",
          mentions: [
            {
              surface: "黑塔",
              referentEntityId: "herta.person.prime",
              confidence: 0.95,
              method: "deterministic",
            },
          ],
        },
      ],
    };
    const claims = extractDeterministicClaims(input);
    const memberNumber = claims.find((c) => c.predicate === "member_number");
    expect(memberNumber).toBeDefined();
    expect(memberNumber?.subjectEntityId).toBe("herta.person.prime");
    expect(memberNumber?.value).toBe("#83");
    expect(memberNumber?.evidenceChunkIds).toEqual(["chunk:1"]);
    expect(memberNumber?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does not emit when the mention is ambiguous", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [],
      chunks: [
        {
          chunkId: "chunk:2",
          text: "黑塔是成员编号#83。",
          mentions: [
            {
              surface: "黑塔",
              referentEntityId: "herta.name.ambiguous",
              confidence: 0.3,
              method: "deterministic",
            },
          ],
        },
      ],
    };
    const claims = extractDeterministicClaims(input);
    expect(claims.find((c) => c.predicate === "member_number")).toBeUndefined();
  });

  it("does not emit when the pattern is missing", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [],
      chunks: [
        {
          chunkId: "chunk:3",
          text: "黑塔在空间站做研究。",
          mentions: [
            {
              surface: "黑塔",
              referentEntityId: "herta.person.prime",
              confidence: 0.95,
              method: "deterministic",
            },
          ],
        },
      ],
    };
    const claims = extractDeterministicClaims(input);
    expect(claims.find((c) => c.predicate === "member_number")).toBeUndefined();
  });

  it("matches the canon phrasing 天才俱乐部#NN", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [],
      chunks: [
        {
          chunkId: "chunk:5",
          text: "黑塔是天才俱乐部#83，专攻模拟宇宙。",
          mentions: [
            {
              surface: "黑塔",
              referentEntityId: "herta.person.prime",
              confidence: 0.95,
              method: "deterministic",
            },
          ],
        },
      ],
    };
    const claims = extractDeterministicClaims(input);
    const memberNumber = claims.find((c) => c.predicate === "member_number");
    expect(memberNumber?.value).toBe("#83");
  });

  it("matches the alternate phrasing #NN号成员", () => {
    const input: ClaimExtractorInput = {
      now: NOW,
      seedEdges: [],
      chunks: [
        {
          chunkId: "chunk:4",
          text: "她是天才俱乐部#83号成员。",
          mentions: [
            {
              surface: "黑塔",
              referentEntityId: "herta.person.prime",
              confidence: 0.95,
              method: "deterministic",
            },
          ],
        },
      ],
    };
    const claims = extractDeterministicClaims(input);
    const memberNumber = claims.find((c) => c.predicate === "member_number");
    expect(memberNumber?.value).toBe("#83");
  });
});
