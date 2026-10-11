import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CanonChunk,
  type CanonDocument,
  HERTA_PERSON_PRIME,
} from "../schema.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";
import { runAlignPass } from "./run-align-pass.js";

const CN_MAP: Record<string, string> = {
  h1: "星核小鬼，过来一趟。",
  h2: "实验结束了。",
};
const EN_MAP: Record<string, string> = {
  h1: "Stellaron twerp, come here for a second.",
  h2: "The experiment is over.",
};

function seed(h: TempDb, id: string, text: string, ordinal: number): void {
  const chunk: CanonChunk = {
    id,
    documentId: "doc-1",
    ordinal,
    sectionPath: ["root"],
    text,
    textHash: `hash-${id}`,
    tokenEstimate: text.length,
    isDialogue: true,
    isHertaVoiceEvidence: true,
    isCanonFactCandidate: false,
    qualityScore: 1,
    speakerEntityId: HERTA_PERSON_PRIME,
  };
  h.store.insertChunk(chunk);
  h.store.upsertVoiceEvidenceStratum({
    chunkId: id,
    speakerEntityId: HERTA_PERSON_PRIME,
    addresseeClass: "player",
    classifierVersion: 2,
    classifiedAt: "2026-07-14T00:00:00.000Z",
  });
}

describe("runAlignPass", () => {
  let h: TempDb;
  beforeEach(() => {
    h = mkTempKnowledgeDb();
    const doc: CanonDocument = {
      id: "doc-1",
      kind: "mission_dialogue",
      title: "Doc",
      path: "data/mission/m1.html",
      sourceHash: "hash-doc-1",
      createdAt: "2026-07-14T00:00:00.000Z",
    };
    h.store.upsertDocument(doc);
  });
  afterEach(() => h.cleanup());

  it("aligns stratified chunks and persists chunk_translations rows", () => {
    seed(h, "c1", "星核小鬼，过来一趟。", 0);
    seed(h, "c2", "维基拼接文本，无对应行", 1);
    const result = runAlignPass({
      store: h.store,
      cnMap: CN_MAP,
      targetMap: EN_MAP,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(result.chunksSeen).toBe(2);
    expect(result.aligned).toBe(1);
    expect(result.byMatchKind).toEqual({ exact: 1, normalized: 0 });
    expect(result.unmatched).toEqual(["c2"]);
    expect(result.noTargetLine).toEqual([]);
    expect(h.store.getChunkTranslation("c1", "en")).toEqual({
      chunkId: "c1",
      lang: "en",
      text: "Stellaron twerp, come here for a second.",
      textmapHash: "h1",
      matchKind: "exact",
      alignedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(h.store.getChunkTranslation("c2", "en")).toBeUndefined();
  });

  it("is idempotent — re-running overwrites rows in place", () => {
    seed(h, "c1", "实验结束了。", 0);
    const opts = {
      store: h.store,
      cnMap: CN_MAP,
      targetMap: EN_MAP,
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    };
    runAlignPass(opts);
    const again = runAlignPass(opts);
    expect(again.aligned).toBe(1);
    expect(h.store.getChunkTranslation("c1", "en")?.alignedAt).toBe(
      "2026-07-15T00:00:00.000Z",
    );
  });

  it("only touches the requested speaker's strata", () => {
    seed(h, "c1", "实验结束了。", 0);
    const result = runAlignPass({
      store: h.store,
      cnMap: CN_MAP,
      targetMap: EN_MAP,
      speakerEntityId: "someone.else",
    });
    expect(result.chunksSeen).toBe(0);
  });
});
