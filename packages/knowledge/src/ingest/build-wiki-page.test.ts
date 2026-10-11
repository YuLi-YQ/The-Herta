import { describe, expect, it } from "vitest";
import type { CanonClaim } from "../schema.js";
import { type BuildWikiPageInput, buildWikiPage } from "./build-wiki-page.js";

const NOW = "2026-05-06T00:00:00.000Z";

function makeInput(over: Partial<BuildWikiPageInput> = {}): BuildWikiPageInput {
  return {
    entity: {
      id: "herta.person.prime",
      type: "person",
      canonicalName: "大黑塔",
      description: "Genius Society #83. The real Herta.",
    },
    aliases: [
      { alias: "大黑塔", lang: "zh", priority: 100 },
      { alias: "黑塔本人", lang: "zh", priority: 90 },
    ],
    activeClaims: [],
    needsReviewClaims: [],
    voiceEvidence: [],
    entityNameLookup: new Map(),
    now: NOW,
    ...over,
  };
}

function claim(over: Partial<CanonClaim> = {}): CanonClaim {
  return {
    id: "claim:test:1",
    subjectEntityId: "herta.person.prime",
    predicate: "owns",
    objectEntityId: "herta.place.space_station",
    evidenceChunkIds: ["chunk:1"],
    confidence: 1.0,
    method: "deterministic",
    status: "active",
    createdAt: NOW,
    ...over,
  };
}

describe("buildWikiPage — basic shape", () => {
  it("populates identity fields from entity", () => {
    const page = buildWikiPage(makeInput());
    expect(page.entityId).toBe("herta.person.prime");
    expect(page.entityType).toBe("person");
    expect(page.canonicalName).toBe("大黑塔");
    expect(page.description).toBe("Genius Society #83. The real Herta.");
    expect(page.generatedAt).toBe(NOW);
  });

  it("sorts aliases by priority desc, then alphabetically", () => {
    const page = buildWikiPage(
      makeInput({
        aliases: [
          { alias: "黑塔本人", lang: "zh", priority: 90 },
          { alias: "大黑塔", lang: "zh", priority: 100 },
          { alias: "Herta (prime)", lang: "en", priority: 50 },
        ],
      }),
    );
    expect(page.aliases.map((a) => a.alias)).toEqual([
      "大黑塔",
      "黑塔本人",
      "Herta (prime)",
    ]);
  });
});

describe("buildWikiPage — relationships and attributes", () => {
  it("splits entity-valued claims into relationships and literal claims into attributes", () => {
    const page = buildWikiPage(
      makeInput({
        activeClaims: [
          claim({
            id: "claim:r1",
            predicate: "owns",
            objectEntityId: "herta.place.space_station",
          }),
          claim({
            id: "claim:a1",
            predicate: "member_number",
            objectEntityId: undefined,
            value: "#83",
          }),
        ],
        entityNameLookup: new Map([
          ["herta.place.space_station", "空间站「黑塔」"],
        ]),
      }),
    );
    expect(page.relationships).toHaveLength(1);
    expect(page.relationships[0]?.targetCanonicalName).toBe("空间站「黑塔」");
    expect(page.relationships[0]?.claimId).toBe("claim:r1");
    expect(page.attributes).toHaveLength(1);
    expect(page.attributes[0]?.value).toBe("#83");
  });

  it("falls back to entityId when name not in lookup", () => {
    const page = buildWikiPage(
      makeInput({
        activeClaims: [
          claim({
            id: "claim:r2",
            predicate: "associated_with",
            objectEntityId: "project.simulated_universe",
          }),
        ],
      }),
    );
    expect(page.relationships[0]?.targetCanonicalName).toBe(
      "project.simulated_universe",
    );
  });

  it("relationships sorted by predicate then targetEntityId", () => {
    const page = buildWikiPage(
      makeInput({
        activeClaims: [
          claim({
            id: "claim:r3",
            predicate: "owns",
            objectEntityId: "herta.work.manuscript",
          }),
          claim({
            id: "claim:r4",
            predicate: "member_of",
            objectEntityId: "faction.genius_society",
          }),
          claim({
            id: "claim:r5",
            predicate: "owns",
            objectEntityId: "herta.place.space_station",
          }),
        ],
      }),
    );
    expect(page.relationships.map((r) => r.predicate)).toEqual([
      "member_of",
      "owns",
      "owns",
    ]);
    expect(page.relationships.slice(1).map((r) => r.targetEntityId)).toEqual([
      "herta.place.space_station",
      "herta.work.manuscript",
    ]);
  });
});

describe("buildWikiPage — voice evidence", () => {
  it("includes voice evidence only when present", () => {
    const page = buildWikiPage(
      makeInput({
        voiceEvidence: [
          {
            chunkId: "chunk:v1",
            documentTitle: "天才群星闪耀时",
            sectionPath: ["剧情"],
            text: "本人远程操纵此处的人偶。",
          },
        ],
      }),
    );
    expect(page.voiceEvidence).toHaveLength(1);
    expect(page.voiceEvidence[0]?.text).toContain("人偶");
  });
});

describe("buildWikiPage — uncertain claims", () => {
  it("collects needs_review claims with their reason", () => {
    const page = buildWikiPage(
      makeInput({
        needsReviewClaims: [
          {
            ...claim({
              id: "claim:nr1",
              predicate: "member_number",
              objectEntityId: undefined,
              value: "#84",
              status: "needs_review",
            }),
            rationale: "conflicts with existing claim",
          },
        ],
      }),
    );
    expect(page.uncertainClaims).toHaveLength(1);
    expect(page.uncertainClaims[0]?.value).toBe("#84");
    expect(page.uncertainClaims[0]?.reason).toMatch(/conflict/i);
  });
});

describe("buildWikiPage — derived id sets", () => {
  it("claimIds includes every active and uncertain claim id; sourceChunkIds unions evidence + voice chunks", () => {
    const page = buildWikiPage(
      makeInput({
        activeClaims: [
          claim({
            id: "claim:r6",
            predicate: "owns",
            objectEntityId: "herta.place.space_station",
            evidenceChunkIds: ["chunk:e1"],
          }),
        ],
        needsReviewClaims: [
          {
            ...claim({
              id: "claim:nr2",
              predicate: "owns",
              objectEntityId: "herta.place.space_station",
              status: "needs_review",
              evidenceChunkIds: ["chunk:e2"],
            }),
          },
        ],
        voiceEvidence: [
          {
            chunkId: "chunk:v1",
            documentTitle: "t",
            sectionPath: [],
            text: "x",
          },
        ],
      }),
    );
    expect([...page.claimIds].sort()).toEqual(["claim:nr2", "claim:r6"]);
    expect([...page.sourceChunkIds].sort()).toEqual([
      "chunk:e1",
      "chunk:e2",
      "chunk:v1",
    ]);
  });
});
