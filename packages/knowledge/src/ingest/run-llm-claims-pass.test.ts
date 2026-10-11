import { describe, expect, it } from "vitest";
import type { CanonDocumentKind } from "../schema.js";
import { mkTempKnowledgeDb } from "../testing/mk-temp-knowledge-db.js";
import { runLlmClaimsPass } from "./run-llm-claims-pass.js";

const NOW = "2026-05-06T00:00:00.000Z";

function seed(h: ReturnType<typeof mkTempKnowledgeDb>): void {
  h.store.upsertDocument({
    id: "doc:1",
    kind: "character_profile" as CanonDocumentKind,
    title: "黑塔",
    path: "data/test/heita.html",
    sourceHash: "h1",
    createdAt: NOW,
  });
  h.store.insertChunk({
    id: "chunk:1",
    documentId: "doc:1",
    ordinal: 0,
    sectionPath: ["简介"],
    text: "黑塔是天才俱乐部#83的成员。",
    textHash: "th1",
    tokenEstimate: 30,
    isDialogue: false,
    isHertaVoiceEvidence: false,
    isCanonFactCandidate: true,
    qualityScore: 0.5,
  });
  h.store.insertMention({
    id: "m1",
    chunkId: "chunk:1",
    surface: "黑塔",
    referentEntityId: "herta.person.prime",
    confidence: 0.95,
    method: "deterministic",
  });
}

describe("runLlmClaimsPass", () => {
  it("calls the LLM, validates the output, applies the resolver, and writes a claim", async () => {
    const h = mkTempKnowledgeDb();
    try {
      seed(h);

      let calls = 0;
      const fakeClient = {
        chatJson: async () => {
          calls += 1;
          return {
            rawJsonText: JSON.stringify({
              claims: [
                {
                  subject_entity_id: "herta.person.prime",
                  predicate: "member_number",
                  value: "#83",
                  evidence_chunk_ids: ["chunk:1"],
                  confidence: 0.92,
                  rationale: "fake-llm",
                },
              ],
            }),
            model: "deepseek-fake",
          };
        },
      };

      const result = await runLlmClaimsPass({
        store: h.store,
        now: NOW,
        llm: {
          client: fakeClient,
          model: "deepseek-fake",
          maxChunks: 100,
          concurrency: 1,
        },
      });
      expect(calls).toBe(1);
      expect(result.proposed).toBe(1);
      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(0);

      const claims = h.store.getClaimsBySubject("herta.person.prime");
      const member = claims.find((c) => c.predicate === "member_number");
      expect(member?.value).toBe("#83");
      expect(member?.method).toBe("llm");
      expect(member?.evidenceChunkIds).toEqual(["chunk:1"]);
    } finally {
      h.cleanup();
    }
  });

  it("re-running the pass with cache warm produces 0 LLM calls and 0 new claims", async () => {
    const h = mkTempKnowledgeDb();
    try {
      seed(h);
      let calls = 0;
      const fakeClient = {
        chatJson: async () => {
          calls += 1;
          return {
            rawJsonText: JSON.stringify({
              claims: [
                {
                  subject_entity_id: "herta.person.prime",
                  predicate: "member_number",
                  value: "#83",
                  evidence_chunk_ids: ["chunk:1"],
                  confidence: 0.92,
                },
              ],
            }),
            model: "deepseek-fake",
          };
        },
      };
      const llm = {
        client: fakeClient,
        model: "deepseek-fake",
        maxChunks: 100,
        concurrency: 1,
      };
      await runLlmClaimsPass({ store: h.store, now: NOW, llm });
      expect(calls).toBe(1);
      const before = h.store.countClaims();
      const r2 = await runLlmClaimsPass({ store: h.store, now: NOW, llm });
      expect(calls).toBe(1); // cache hit
      expect(h.store.countClaims()).toBe(before);
      expect(r2.accepted).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("rejects ambiguous-subject claims silently (counts in rejected)", async () => {
    const h = mkTempKnowledgeDb();
    try {
      seed(h);
      const fakeClient = {
        chatJson: async () => ({
          rawJsonText: JSON.stringify({
            claims: [
              {
                subject_entity_id: "herta.name.ambiguous",
                predicate: "member_number",
                value: "#83",
                evidence_chunk_ids: ["chunk:1"],
                confidence: 0.9,
              },
            ],
          }),
          model: "deepseek-fake",
        }),
      };
      const result = await runLlmClaimsPass({
        store: h.store,
        now: NOW,
        llm: {
          client: fakeClient,
          model: "deepseek-fake",
          maxChunks: 100,
          concurrency: 1,
        },
      });
      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
