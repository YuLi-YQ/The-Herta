import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeepSeekClient } from "../llm/types.js";
import {
  type CanonChunk,
  type CanonDocument,
  HERTA_PERSON_PRIME,
} from "../schema.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";
import { runRestratifyLlmPass } from "./run-restratify-llm-pass.js";

class FakeClient implements DeepSeekClient {
  public callCount = 0;
  constructor(private readonly responses: string[]) {}
  async chatJson() {
    this.callCount++;
    const next = this.responses.shift();
    if (next === undefined) throw new Error("FakeClient: no more responses");
    return { rawJsonText: next, model: "fake" };
  }
}

const FIXTURE_HTML =
  "<html>螺丝咕姆: 黑塔。  黑塔: 嗯？小家伙。 黑塔: 这个不难。</html>";

function seedDocAndChunks(h: TempDb, htmlPath: string) {
  const doc: CanonDocument = {
    id: "doc1",
    kind: "mission_dialogue",
    title: "test",
    path: htmlPath,
    sourceHash: "h1",
    createdAt: "2026-05-09T00:00:00Z",
  };
  h.store.upsertDocument(doc);
  const chunks: CanonChunk[] = [
    {
      id: "doc1#1",
      documentId: "doc1",
      ordinal: 1,
      sectionPath: [],
      speaker: "黑塔",
      speakerEntityId: HERTA_PERSON_PRIME,
      authorEntityId: undefined,
      text: "嗯？小家伙。",
      textHash: "th1",
      tokenEstimate: 5,
      isDialogue: true,
      isHertaVoiceEvidence: true,
      isCanonFactCandidate: false,
      qualityScore: 1.0,
    },
    {
      id: "doc1#2",
      documentId: "doc1",
      ordinal: 2,
      sectionPath: [],
      speaker: "黑塔",
      speakerEntityId: HERTA_PERSON_PRIME,
      authorEntityId: undefined,
      text: "这个不难。",
      textHash: "th2",
      tokenEstimate: 5,
      isDialogue: true,
      isHertaVoiceEvidence: true,
      isCanonFactCandidate: false,
      qualityScore: 1.0,
    },
  ];
  for (const c of chunks) h.store.upsertChunk(c);
  // Seed entities so the validator's known-entity check passes
  h.store.upsertEntity({
    id: HERTA_PERSON_PRIME,
    kind: "person",
    canonicalName: "Herta",
    aliases: ["黑塔"],
  });
  h.store.upsertEntity({
    id: "person.screwllum",
    kind: "person",
    canonicalName: "Screwllum",
    aliases: ["螺丝咕姆"],
  });
}

const RESPONSE_AGREE = JSON.stringify({
  schemaVersion: 1,
  classifications: [
    {
      chunk_id: "doc1#1",
      addressee_class: "player",
      addressee_entity_id: null,
      mood: "interested",
      register_mode: "teaching",
      grounded_citation: "嗯？小家伙",
      reasoning: "addresses player",
    },
    {
      chunk_id: "doc1#2",
      addressee_class: "player",
      addressee_entity_id: null,
      mood: "interested",
      register_mode: "teaching",
      grounded_citation: "嗯？小家伙",
      reasoning: "addresses player",
    },
  ],
});

describe("runRestratifyLlmPass", () => {
  let tmpHtml: string;
  let h: TempDb;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restratify-"));
    tmpHtml = path.join(dir, "scene.html");
    fs.writeFileSync(tmpHtml, FIXTURE_HTML, "utf8");
    h = mkTempKnowledgeDb();
    seedDocAndChunks(h, tmpHtml);
  });

  afterEach(() => h.cleanup());

  it("on consensus, writes one consensus stratum row per chunk", async () => {
    const client = new FakeClient([RESPONSE_AGREE, RESPONSE_AGREE]);
    const out = await runRestratifyLlmPass({
      store: h.store,
      client,
      speakerEntityId: HERTA_PERSON_PRIME,
      now: () => new Date("2026-05-09T00:00:00Z"),
    });
    expect(client.callCount).toBe(2);
    expect(out.docsProcessed).toBe(1);
    expect(out.chunksWithConsensus).toBe(2);
    const s = h.store.getVoiceEvidenceStratumLlm("doc1#1");
    expect(s?.source).toBe("consensus");
    expect(s?.addresseeClass).toBe("player");
  });

  it("aborts early when disagreement-with-heuristic rate exceeds threshold", async () => {
    h.store.upsertVoiceEvidenceStratumLlm({
      chunkId: "doc1#1",
      speakerEntityId: HERTA_PERSON_PRIME,
      addresseeClass: "other_named",
      addresseeEntityId: "person.screwllum",
      classifierVersion: 2,
      classifiedAt: "2026-05-08T00:00:00Z",
      source: "heuristic",
      disagreementWithHeuristic: false,
    });
    h.store.upsertVoiceEvidenceStratumLlm({
      chunkId: "doc1#2",
      speakerEntityId: HERTA_PERSON_PRIME,
      addresseeClass: "other_named",
      addresseeEntityId: "person.screwllum",
      classifierVersion: 2,
      classifiedAt: "2026-05-08T00:00:00Z",
      source: "heuristic",
      disagreementWithHeuristic: false,
    });
    const client = new FakeClient([RESPONSE_AGREE, RESPONSE_AGREE]);
    const out = await runRestratifyLlmPass({
      store: h.store,
      client,
      speakerEntityId: HERTA_PERSON_PRIME,
      abortOnDisagreementRate: 0.1,
      now: () => new Date("2026-05-09T00:00:00Z"),
    });
    expect(out.aborted).toBe(true);
    expect(out.disagreementRate).toBeGreaterThan(0.1);
  });

  // Salvaged from the retired voice-pipeline end-to-end test: multi-doc pass
  // (2 docs × 2 prompt framings = 4 LLM calls) writing consensus rows for
  // both player-class and other_named-class chunks.
  it("processes multiple docs and writes other_named consensus rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restratify-doc2-"));
    const doc2Html = path.join(dir, "scene-2.html");
    fs.writeFileSync(
      doc2Html,
      "<html>黑塔: 阮·梅，把数据给我。 黑塔: 你这个想法有意思。</html>",
      "utf8",
    );
    h.store.upsertDocument({
      id: "doc2",
      kind: "mission_dialogue",
      title: "test-2",
      path: doc2Html,
      sourceHash: "h2",
      createdAt: "2026-05-09T00:00:00Z",
    });
    for (const [id, ord, text, hash] of [
      ["doc2#1", 1, "阮·梅，把数据给我。", "t2a"],
      ["doc2#2", 2, "你这个想法有意思。", "t2b"],
    ] as Array<[string, number, string, string]>) {
      h.store.upsertChunk({
        id,
        documentId: "doc2",
        ordinal: ord,
        sectionPath: [],
        speaker: "黑塔",
        speakerEntityId: HERTA_PERSON_PRIME,
        authorEntityId: undefined,
        text,
        textHash: hash,
        tokenEstimate: text.length,
        isDialogue: true,
        isHertaVoiceEvidence: true,
        isCanonFactCandidate: false,
        qualityScore: 1.0,
      });
    }
    h.store.upsertEntity({
      id: "person.ruan_mei",
      kind: "person",
      canonicalName: "Ruan Mei",
      aliases: ["阮·梅"],
    });

    const responseDoc2 = JSON.stringify({
      schemaVersion: 1,
      classifications: [
        {
          chunk_id: "doc2#1",
          addressee_class: "other_named",
          addressee_entity_id: "person.ruan_mei",
          mood: "interested",
          register_mode: "technical",
          grounded_citation: "阮·梅",
          reasoning: "addresses Ruan Mei",
        },
        {
          chunk_id: "doc2#2",
          addressee_class: "other_named",
          addressee_entity_id: "person.ruan_mei",
          mood: "interested",
          register_mode: "technical",
          grounded_citation: "阮·梅",
          reasoning: "continues to Ruan Mei",
        },
      ],
    });

    // doc1 pass A/B, doc2 pass A/B — 4 calls total.
    const client = new FakeClient([
      RESPONSE_AGREE,
      RESPONSE_AGREE,
      responseDoc2,
      responseDoc2,
    ]);
    const out = await runRestratifyLlmPass({
      store: h.store,
      client,
      speakerEntityId: HERTA_PERSON_PRIME,
      now: () => new Date("2026-05-09T00:00:00Z"),
    });
    expect(client.callCount).toBe(4);
    expect(out.docsProcessed).toBe(2);
    expect(h.store.getVoiceEvidenceStratumLlm("doc1#1")?.source).toBe(
      "consensus",
    );
    const s2 = h.store.getVoiceEvidenceStratumLlm("doc2#1");
    expect(s2?.source).toBe("consensus");
    expect(s2?.addresseeClass).toBe("other_named");
    expect(s2?.addresseeEntityIdLlm).toBe("person.ruan_mei");
  });

  it("dry-run: makes no DB writes and returns estimated counts", async () => {
    const client = new FakeClient([]);
    const out = await runRestratifyLlmPass({
      store: h.store,
      client,
      speakerEntityId: HERTA_PERSON_PRIME,
      dryRun: true,
      now: () => new Date("2026-05-09T00:00:00Z"),
    });
    expect(client.callCount).toBe(0);
    expect(out.estimatedCalls).toBe(2);
    expect(h.store.getVoiceEvidenceStratumLlm("doc1#1")).toBeUndefined();
  });
});
