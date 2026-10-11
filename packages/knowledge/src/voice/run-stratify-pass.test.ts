import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CanonChunk,
  type CanonDocument,
  HERTA_PERSON_PRIME,
} from "../schema.js";
import { PERSON_SCREWLLUM } from "../seed/entities.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";
import { runStratifyPass } from "./run-stratify-pass.js";
import { STRATIFY_CLASSIFIER_VERSION } from "./stratify.js";

interface SeedChunkOpts {
  id: string;
  documentId: string;
  text: string;
  speakerEntityId?: string;
}

function seedDoc(
  h: TempDb,
  opts: Partial<CanonDocument> & { id: string; path: string },
): void {
  const doc: CanonDocument = {
    id: opts.id,
    kind: opts.kind ?? "mission_dialogue",
    title: opts.title ?? `Doc ${opts.id}`,
    path: opts.path,
    sourceHash: opts.sourceHash ?? `hash-${opts.id}`,
    pageSubjectEntityId: opts.pageSubjectEntityId,
    createdAt: opts.createdAt ?? new Date("2026-05-08").toISOString(),
  };
  h.store.upsertDocument(doc);
}

// Auto-increment ordinal per document — chunks have a (document_id, ordinal)
// uniqueness constraint, so seeding multiple chunks under one doc requires
// distinct ordinals.
const nextOrdinal = new Map<string, number>();

function seedChunk(h: TempDb, opts: SeedChunkOpts): void {
  const ord = nextOrdinal.get(opts.documentId) ?? 0;
  nextOrdinal.set(opts.documentId, ord + 1);
  const chunk: CanonChunk = {
    id: opts.id,
    documentId: opts.documentId,
    ordinal: ord,
    sectionPath: ["root"],
    text: opts.text,
    textHash: `hash-${opts.id}`,
    tokenEstimate: opts.text.length,
    isDialogue: true,
    isHertaVoiceEvidence: opts.speakerEntityId === HERTA_PERSON_PRIME,
    isCanonFactCandidate: false,
    qualityScore: 1,
    speakerEntityId: opts.speakerEntityId,
  };
  h.store.insertChunk(chunk);
}

describe("runStratifyPass", () => {
  let h: TempDb;
  beforeEach(() => {
    h = mkTempKnowledgeDb();
    nextOrdinal.clear();
  });
  afterEach(() => h.cleanup());

  it("returns zero counts when there are no Herta-spoken chunks", () => {
    const result = runStratifyPass({ store: h.store });
    expect(result).toEqual({
      chunksClassified: 0,
      byClass: { player: 0, other_named: 0, self_narration: 0, unknown: 0 },
    });
  });

  it("classifies a single Herta chunk addressing the player", () => {
    seedDoc(h, {
      id: "doc-mission",
      path: "data/mission/m1.html",
      kind: "mission_dialogue",
    });
    seedChunk(h, {
      id: "c1",
      documentId: "doc-mission",
      text: "星，你过来一趟。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });

    const result = runStratifyPass({
      store: h.store,
      now: () => new Date("2026-05-08T00:00:00Z"),
    });

    expect(result.chunksClassified).toBe(1);
    expect(result.byClass).toEqual({
      player: 1,
      other_named: 0,
      self_narration: 0,
      unknown: 0,
    });
    const stratum = h.store.getVoiceEvidenceStratum("c1");
    expect(stratum).toBeDefined();
    expect(stratum?.addresseeClass).toBe("player");
    expect(stratum?.speakerEntityId).toBe(HERTA_PERSON_PRIME);
    expect(stratum?.classifierVersion).toBe(STRATIFY_CLASSIFIER_VERSION);
  });

  it("counts a mixed corpus correctly and ignores non-Herta chunks", () => {
    seedDoc(h, {
      id: "doc-mission",
      path: "data/mission/m1.html",
      kind: "mission_dialogue",
    });
    seedDoc(h, {
      id: "doc-book",
      path: "data/book/h1.html",
      kind: "book_readable",
      pageSubjectEntityId: HERTA_PERSON_PRIME,
    });

    // 5 player chunks (Herta + Trailblazer alias + 你)
    for (let i = 0; i < 5; i += 1) {
      seedChunk(h, {
        id: `cp${i}`,
        documentId: "doc-mission",
        text: `星，你听好第${i}件事。`,
        speakerEntityId: HERTA_PERSON_PRIME,
      });
    }
    // 3 other_named chunks (Herta + 螺丝咕姆 + 你)
    for (let i = 0; i < 3; i += 1) {
      seedChunk(h, {
        id: `co${i}`,
        documentId: "doc-mission",
        text: `螺丝咕姆，你看第${i}号设计图。`,
        speakerEntityId: HERTA_PERSON_PRIME,
      });
    }
    // 2 unknown chunks (Herta, no addressee signals)
    for (let i = 0; i < 2; i += 1) {
      seedChunk(h, {
        id: `cu${i}`,
        documentId: "doc-mission",
        text: `空间站今天的实验日志第${i}条。`,
        speakerEntityId: HERTA_PERSON_PRIME,
      });
    }
    // 1 self_narration chunk (Herta, book authored by Herta)
    seedChunk(h, {
      id: "cs0",
      documentId: "doc-book",
      text: "在我看来，万物皆可被解构。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });
    // 1 chunk with a non-Herta speaker — must be skipped.
    seedChunk(h, {
      id: "cother",
      documentId: "doc-mission",
      text: "你给我闭嘴。",
      speakerEntityId: PERSON_SCREWLLUM,
    });
    // 1 chunk with no speaker_entity_id — also skipped.
    seedChunk(h, {
      id: "cnospeaker",
      documentId: "doc-mission",
      text: "（旁白）",
    });

    const result = runStratifyPass({ store: h.store });

    expect(result.chunksClassified).toBe(11); // 5 + 3 + 2 + 1
    expect(result.byClass).toEqual({
      player: 5,
      other_named: 3,
      self_narration: 1,
      unknown: 2,
    });
    expect(h.store.getVoiceEvidenceStratum("cother")).toBeUndefined();
    expect(h.store.getVoiceEvidenceStratum("cnospeaker")).toBeUndefined();
    // other_named row carries the addressee entity id.
    const o0 = h.store.getVoiceEvidenceStratum("co0");
    expect(o0?.addresseeClass).toBe("other_named");
    expect(o0?.addresseeEntityId).toBe(PERSON_SCREWLLUM);
  });

  it("is idempotent across re-runs at the same classifier version", () => {
    seedDoc(h, {
      id: "doc-mission",
      path: "data/mission/m1.html",
      kind: "mission_dialogue",
    });
    seedChunk(h, {
      id: "c1",
      documentId: "doc-mission",
      text: "星，你过来一趟。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });
    seedChunk(h, {
      id: "c2",
      documentId: "doc-mission",
      text: "螺丝咕姆，你看一下这个。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });

    runStratifyPass({ store: h.store });
    const firstCount = h.store.countStrata(HERTA_PERSON_PRIME);
    expect(firstCount).toBe(2);

    const second = runStratifyPass({ store: h.store });
    expect(second.chunksClassified).toBe(2);
    expect(h.store.countStrata(HERTA_PERSON_PRIME)).toBe(2); // no duplicates
    expect(h.store.countStrata(HERTA_PERSON_PRIME, "player")).toBe(1);
    expect(h.store.countStrata(HERTA_PERSON_PRIME, "other_named")).toBe(1);
  });

  it("Rule 4: classifies chunks in 开拓任务/ documents as player even without alias", () => {
    // The 小家伙 case: Herta speaks in a player-protagonist quest doc with
    // 你 but no Trailblazer alias mentioned in the chunk itself.
    seedDoc(h, {
      id: "doc-tb-quest",
      path: "data/plot_html/开拓任务/164_流年啊，渡我漂游千百载.html",
      kind: "mission_dialogue",
    });
    seedDoc(h, {
      id: "doc-event-quest",
      path: "data/plot_html/活动任务/082_test.html",
      kind: "mission_dialogue",
    });

    // Player-protagonist doc + 你 + no alias — Rule 4 fires.
    seedChunk(h, {
      id: "ctb",
      documentId: "doc-tb-quest",
      text: "小家伙，我在系统里留下了教学引导，你照着做就好。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });
    // Activity-quest doc + 你 + no alias — Rule 4 does NOT fire; unknown.
    seedChunk(h, {
      id: "cevent",
      documentId: "doc-event-quest",
      text: "你这次的方法太繁琐了。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });

    const result = runStratifyPass({ store: h.store });

    expect(result.byClass.player).toBe(1);
    expect(result.byClass.unknown).toBe(1);
    expect(h.store.getVoiceEvidenceStratum("ctb")?.addresseeClass).toBe(
      "player",
    );
    expect(h.store.getVoiceEvidenceStratum("cevent")?.addresseeClass).toBe(
      "unknown",
    );
  });

  it("overwrites existing rows when classifier version is bumped", () => {
    seedDoc(h, {
      id: "doc-mission",
      path: "data/mission/m1.html",
      kind: "mission_dialogue",
    });
    seedChunk(h, {
      id: "c1",
      documentId: "doc-mission",
      text: "星，你过来一趟。",
      speakerEntityId: HERTA_PERSON_PRIME,
    });

    runStratifyPass({
      store: h.store,
      now: () => new Date("2026-05-08T00:00:00Z"),
    });
    const first = h.store.getVoiceEvidenceStratum("c1");
    expect(first?.classifierVersion).toBe(STRATIFY_CLASSIFIER_VERSION);
    expect(first?.classifiedAt).toBe("2026-05-08T00:00:00.000Z");

    runStratifyPass({
      store: h.store,
      classifierVersion: STRATIFY_CLASSIFIER_VERSION + 1,
      now: () => new Date("2026-05-09T00:00:00Z"),
    });
    const second = h.store.getVoiceEvidenceStratum("c1");
    expect(second?.classifierVersion).toBe(STRATIFY_CLASSIFIER_VERSION + 1);
    expect(second?.classifiedAt).toBe("2026-05-09T00:00:00.000Z");
    expect(h.store.countStrata(HERTA_PERSON_PRIME)).toBe(1); // still one row
  });
});
