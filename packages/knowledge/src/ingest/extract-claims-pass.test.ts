import { describe, expect, it } from "vitest";
import { SEED_EDGES } from "../seed/entities.js";
import { mkTempKnowledgeDb } from "../testing/mk-temp-knowledge-db.js";
import { runExtractClaimsPass } from "./extract-claims-pass.js";

describe("runExtractClaimsPass", () => {
  it("writes one claim per seed edge", () => {
    const h = mkTempKnowledgeDb();
    try {
      const result = runExtractClaimsPass({
        store: h.store,
        now: "2026-05-06T00:00:00.000Z",
      });
      expect(result.seedClaimsWritten).toBe(SEED_EDGES.length);
      expect(h.store.countClaims()).toBe(SEED_EDGES.length);
    } finally {
      h.cleanup();
    }
  });

  it("re-running the pass is idempotent (no duplicates)", () => {
    const h = mkTempKnowledgeDb();
    try {
      runExtractClaimsPass({ store: h.store, now: "2026-05-06T00:00:00.000Z" });
      const firstCount = h.store.countClaims();
      runExtractClaimsPass({ store: h.store, now: "2026-05-06T00:00:01.000Z" });
      expect(h.store.countClaims()).toBe(firstCount);
    } finally {
      h.cleanup();
    }
  });

  it("extracts member_number claims for chunks with the pattern", () => {
    const h = mkTempKnowledgeDb();
    try {
      h.store.upsertDocument({
        id: "doc:1",
        kind: "character_profile",
        title: "黑塔",
        path: "data/test/heita.html",
        sourceHash: "h1",
        createdAt: "2026-05-06T00:00:00.000Z",
      });
      h.store.insertChunk({
        id: "chunk:1",
        documentId: "doc:1",
        ordinal: 0,
        sectionPath: ["简介"],
        text: "黑塔是天才俱乐部成员编号#83，专注模拟宇宙研究。",
        textHash: "th1",
        tokenEstimate: 30,
        isDialogue: false,
        isHertaVoiceEvidence: false,
        isCanonFactCandidate: true,
        qualityScore: 0.5,
      });
      h.store.insertMention({
        id: "mention:1",
        chunkId: "chunk:1",
        surface: "黑塔",
        referentEntityId: "herta.person.prime",
        confidence: 0.95,
        method: "deterministic",
      });

      const result = runExtractClaimsPass({
        store: h.store,
        now: "2026-05-06T00:00:00.000Z",
      });
      expect(result.textClaimsWritten).toBeGreaterThanOrEqual(1);
      const personClaims = h.store.getClaimsBySubject("herta.person.prime");
      const member = personClaims.find((c) => c.predicate === "member_number");
      expect(member?.value).toBe("#83");
      expect(member?.evidenceChunkIds).toEqual(["chunk:1"]);
    } finally {
      h.cleanup();
    }
  });
});
