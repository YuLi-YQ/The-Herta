import { describe, expect, it } from "vitest";
import { HERTA_PERSON_PRIME } from "../schema.js";
import { classifyAddressee, STRATIFY_CLASSIFIER_VERSION } from "./stratify.js";

const PERSON_SCREWLLUM = "person.screwllum";
const PERSON_RUAN_MEI = "person.ruan_mei";

function input(opts: {
  text: string;
  speakerEntityId?: string;
  docKind?: string;
  docPath?: string;
  pageSubjectEntityId?: string;
  otherHits?: ReadonlyArray<{ entityId: string; alias: string }>;
}): Parameters<typeof classifyAddressee>[0] {
  return {
    chunk: {
      id: "chunk-1",
      text: opts.text,
      speakerEntityId: opts.speakerEntityId ?? HERTA_PERSON_PRIME,
    },
    document: {
      id: "doc-1",
      kind: (opts.docKind ?? "mission_dialogue") as never,
      // Default: non-player-protagonist path so Rule 4 does NOT fire unless
      // a test explicitly opts in via docPath.
      path: opts.docPath ?? "data/plot_html/活动任务/test.html",
      pageSubjectEntityId: opts.pageSubjectEntityId,
    },
    otherEntityHits: opts.otherHits ?? [],
  };
}

describe("classifyAddressee", () => {
  it("exposes a numeric classifier version", () => {
    expect(STRATIFY_CLASSIFIER_VERSION).toBe(2);
  });

  it("returns self_narration when document is book_readable authored by speaker", () => {
    const out = classifyAddressee(
      input({
        text: "在我看来，万物皆可被解构。",
        docKind: "book_readable",
        pageSubjectEntityId: HERTA_PERSON_PRIME,
      }),
    );
    expect(out).toEqual({ addresseeClass: "self_narration" });
  });

  it("classifies as player when text contains 星 + second-person pronoun", () => {
    const out = classifyAddressee(
      input({ text: "星，你过来一下，我有个实验给你做。" }),
    );
    expect(out).toEqual({ addresseeClass: "player" });
  });

  it("classifies as player when text contains 开拓者 + second-person pronoun", () => {
    const out = classifyAddressee(input({ text: "开拓者，你倒是看仔细了。" }));
    expect(out).toEqual({ addresseeClass: "player" });
  });

  it("classifies as player when text contains Stelle + second-person (exact case)", () => {
    const out = classifyAddressee(input({ text: "Stelle，你来得正好。" }));
    expect(out).toEqual({ addresseeClass: "player" });
  });

  it("classifies as other_named when text contains 螺丝咕姆 + second-person", () => {
    const out = classifyAddressee(
      input({
        text: "螺丝咕姆，你那个新发明的图纸我看过了。",
        otherHits: [{ entityId: PERSON_SCREWLLUM, alias: "螺丝咕姆" }],
      }),
    );
    expect(out).toEqual({
      addresseeClass: "other_named",
      addresseeEntityId: PERSON_SCREWLLUM,
    });
  });

  it("uses first hit when text mentions multiple non-player entities + second-person", () => {
    const out = classifyAddressee(
      input({
        text: "螺丝咕姆，关于阮梅的提案，你怎么看？",
        // Order matters — orchestrator pre-sorts by entityId for determinism.
        otherHits: [
          { entityId: PERSON_RUAN_MEI, alias: "阮梅" },
          { entityId: PERSON_SCREWLLUM, alias: "螺丝咕姆" },
        ],
      }),
    );
    expect(out).toEqual({
      addresseeClass: "other_named",
      addresseeEntityId: PERSON_RUAN_MEI,
    });
  });

  it("returns unknown when no second-person pronoun is present", () => {
    const out = classifyAddressee(
      input({
        text: "开拓者今天来过空间站。", // mentions player alias but no 你/您/你们
        otherHits: [],
      }),
    );
    expect(out).toEqual({ addresseeClass: "unknown" });
  });

  it("returns unknown when second-person pronoun is present but no entity mentioned", () => {
    const out = classifyAddressee(input({ text: "你听好了，这是关键步骤。" }));
    expect(out).toEqual({ addresseeClass: "unknown" });
  });

  it("returns unknown when book_readable but author does not match speaker", () => {
    const out = classifyAddressee(
      input({
        text: "黑塔的某段独白。",
        docKind: "book_readable",
        pageSubjectEntityId: "person.someone_else",
      }),
    );
    expect(out).toEqual({ addresseeClass: "unknown" });
  });

  it("prioritizes player over other_named when both signals are present", () => {
    const out = classifyAddressee(
      input({
        // Player alias 星 AND a non-player entity mention AND 你 — player wins.
        text: "星，你和螺丝咕姆一起来一趟。",
        otherHits: [{ entityId: PERSON_SCREWLLUM, alias: "螺丝咕姆" }],
      }),
    );
    expect(out).toEqual({ addresseeClass: "player" });
  });

  // --- Rule 4: document-context fallback (player-protagonist directories) ---

  it("Rule 4: classifies as player when 你 + no entity in 开拓任务/ document", () => {
    // Real corpus example: chunk uses 小家伙 + 你 in a player-protagonist
    // quest. Rule 2 doesn't fire (no Trailblazer alias). Rule 3 doesn't
    // fire (no other entity). Rule 4 catches it via document context.
    const out = classifyAddressee(
      input({
        text: "小家伙，我在系统里留下了教学引导，你照着做就好。",
        docPath: "data/plot_html/开拓任务/091_test.html",
      }),
    );
    expect(out).toEqual({ addresseeClass: "player" });
  });

  it("Rule 4 still requires a second-person pronoun (not just document genre)", () => {
    // Pure vocative without 你 — Rule 4 stays silent. Avoids tagging
    // "talking ABOUT the player to others" chunks as player-register.
    const out = classifyAddressee(
      input({
        text: "是啊，这小家伙的体质真奇怪。",
        docPath: "data/plot_html/开拓任务/005_阴影从未离去.html",
      }),
    );
    expect(out).toEqual({ addresseeClass: "unknown" });
  });

  it("Rule 4: also fires for 开拓续闻/ and 同行任务/ documents", () => {
    const opts = [
      "data/plot_html/开拓续闻/001_天才群星闪耀时.html",
      "data/plot_html/同行任务/025_朋克洛德精神.html",
    ];
    for (const docPath of opts) {
      const out = classifyAddressee(
        input({ text: "你这次表现得不错。", docPath }),
      );
      expect(out).toEqual({ addresseeClass: "player" });
    }
  });

  it("Rule 4 does NOT fire for 活动任务/ — addressee stays unknown", () => {
    // Activity quests are mixed-protagonist; gating Rule 4 to player-only
    // directories keeps Herta-to-NPC dialogue from being mis-classified.
    const out = classifyAddressee(
      input({
        text: "你的方法太繁琐了。",
        docPath: "data/plot_html/活动任务/082_智斗！空间站「黑塔」.html",
      }),
    );
    expect(out).toEqual({ addresseeClass: "unknown" });
  });

  it("Rule 3 still wins over Rule 4 when an other-named entity is present", () => {
    // Even in a player-protagonist directory, if the chunk explicitly names
    // another entity + has 你, Rule 3 fires first and Rule 4 never runs.
    const out = classifyAddressee(
      input({
        text: "螺丝咕姆，你这次的方法太繁琐了。",
        docPath: "data/plot_html/开拓任务/005_阴影从未离去.html",
        otherHits: [{ entityId: PERSON_SCREWLLUM, alias: "螺丝咕姆" }],
      }),
    );
    expect(out).toEqual({
      addresseeClass: "other_named",
      addresseeEntityId: PERSON_SCREWLLUM,
    });
  });
});
