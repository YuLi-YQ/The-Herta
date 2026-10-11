import { describe, expect, it } from "vitest";
import { mkTempKnowledgeDb } from "../testing/mk-temp-knowledge-db.js";
import { runWikiPagesPass } from "./run-wiki-pages-pass.js";

const NOW = "2026-05-06T00:00:00.000Z";

describe("runWikiPagesPass", () => {
  it("writes a page for every entity that has at least one active claim", () => {
    const h = mkTempKnowledgeDb();
    try {
      h.store.insertClaim({
        id: "claim:seed:r1",
        subjectEntityId: "herta.person.prime",
        predicate: "owns",
        objectEntityId: "herta.place.space_station",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: NOW,
      });
      const result = runWikiPagesPass({ store: h.store, now: NOW });
      expect(result.pagesWritten).toBeGreaterThanOrEqual(1);
      const page = h.store.getWikiPage("herta.person.prime");
      expect(page?.relationships).toHaveLength(1);
      expect(page?.relationships[0]?.targetCanonicalName).toBe(
        "空间站「黑塔」",
      );
    } finally {
      h.cleanup();
    }
  });

  it("skips entities with zero active and zero needs_review claims", () => {
    const h = mkTempKnowledgeDb();
    try {
      const result = runWikiPagesPass({ store: h.store, now: NOW });
      expect(result.pagesWritten).toBe(0);
      expect(result.entitiesSkipped).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it("re-running with same data is idempotent (count unchanged)", () => {
    const h = mkTempKnowledgeDb();
    try {
      h.store.insertClaim({
        id: "claim:seed:r2",
        subjectEntityId: "herta.person.prime",
        predicate: "owns",
        objectEntityId: "herta.place.space_station",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: NOW,
      });
      runWikiPagesPass({ store: h.store, now: NOW });
      const before = h.store.countWikiPages();
      runWikiPagesPass({ store: h.store, now: "2026-05-06T01:00:00.000Z" });
      expect(h.store.countWikiPages()).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it("includes voice-evidence chunks for person entities only", () => {
    const h = mkTempKnowledgeDb();
    try {
      h.store.upsertDocument({
        id: "doc:wp1",
        kind: "mission_dialogue",
        title: "对话",
        path: "data/test/d.html",
        sourceHash: "h",
        createdAt: NOW,
      });
      h.store.insertChunk({
        id: "chunk:wp1",
        documentId: "doc:wp1",
        ordinal: 0,
        sectionPath: ["对话"],
        speaker: "黑塔",
        speakerEntityId: "herta.person.prime",
        text: "实验。",
        textHash: "th",
        tokenEstimate: 2,
        isDialogue: true,
        isHertaVoiceEvidence: true,
        isCanonFactCandidate: false,
        qualityScore: 0.9,
      });
      h.store.insertClaim({
        id: "claim:seed:vc",
        subjectEntityId: "herta.person.prime",
        predicate: "owns",
        objectEntityId: "herta.place.space_station",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: NOW,
      });
      h.store.insertClaim({
        id: "claim:seed:place",
        subjectEntityId: "herta.place.space_station",
        predicate: "owns",
        objectEntityId: "herta.work.manuscript",
        evidenceChunkIds: [],
        confidence: 1.0,
        method: "deterministic",
        status: "active",
        createdAt: NOW,
      });
      runWikiPagesPass({ store: h.store, now: NOW });
      const personPage = h.store.getWikiPage("herta.person.prime");
      const placePage = h.store.getWikiPage("herta.place.space_station");
      expect(personPage?.voiceEvidence).toHaveLength(1);
      expect(placePage?.voiceEvidence).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});
