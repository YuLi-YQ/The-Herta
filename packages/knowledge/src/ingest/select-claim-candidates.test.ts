import { describe, expect, it } from "vitest";
import {
  type ClaimCandidateInput,
  selectClaimCandidates,
} from "./select-claim-candidates.js";

function chunk(over: Partial<ClaimCandidateInput> = {}): ClaimCandidateInput {
  return {
    chunkId: "chunk:1",
    isCanonFactCandidate: true,
    documentKind: "character_profile",
    mentions: [
      {
        surface: "黑塔",
        referentEntityId: "herta.person.prime",
        confidence: 0.95,
      },
    ],
    ...over,
  };
}

describe("selectClaimCandidates", () => {
  it("includes a chunk that is a fact-candidate with at least one disambiguated person mention", () => {
    expect(selectClaimCandidates([chunk()], 100)).toHaveLength(1);
  });

  it("excludes a chunk that is not a fact-candidate", () => {
    expect(
      selectClaimCandidates([chunk({ isCanonFactCandidate: false })], 100),
    ).toHaveLength(0);
  });

  it("excludes a chunk whose only mention is ambiguous", () => {
    expect(
      selectClaimCandidates(
        [
          chunk({
            mentions: [
              {
                surface: "黑塔",
                referentEntityId: "herta.name.ambiguous",
                confidence: 0.3,
              },
            ],
          }),
        ],
        100,
      ),
    ).toHaveLength(0);
  });

  it("excludes a chunk with no person.* / herta.person.* mention above threshold", () => {
    expect(
      selectClaimCandidates(
        [
          chunk({
            mentions: [
              {
                surface: "空间站",
                referentEntityId: "herta.place.space_station",
                confidence: 0.95,
              },
            ],
          }),
        ],
        100,
      ),
    ).toHaveLength(0);
  });

  it("respects the maxCount cap", () => {
    const inputs = Array.from({ length: 5 }, (_, i) =>
      chunk({ chunkId: `chunk:${i}` }),
    );
    expect(selectClaimCandidates(inputs, 3)).toHaveLength(3);
  });

  it("ranks character_profile chunks above mission_dialogue when slicing", () => {
    const inputs: ClaimCandidateInput[] = [
      chunk({ chunkId: "dialog:1", documentKind: "mission_dialogue" }),
      chunk({ chunkId: "profile:1", documentKind: "character_profile" }),
      chunk({ chunkId: "dialog:2", documentKind: "mission_dialogue" }),
    ];
    const out = selectClaimCandidates(inputs, 2);
    expect(out.map((c) => c.chunkId)).toEqual(["profile:1", "dialog:1"]);
  });

  it("preserves original order within the same document kind (stable rank)", () => {
    const inputs: ClaimCandidateInput[] = [
      chunk({ chunkId: "p:b", documentKind: "character_profile" }),
      chunk({ chunkId: "p:a", documentKind: "character_profile" }),
      chunk({ chunkId: "p:c", documentKind: "character_profile" }),
    ];
    const out = selectClaimCandidates(inputs, 3);
    expect(out.map((c) => c.chunkId)).toEqual(["p:b", "p:a", "p:c"]);
  });
});
