import { describe, expect, it } from "vitest";
import {
  alignChunk,
  buildAlignmentIndex,
  normalizeForAlignment,
} from "./align-translations.js";

const CN_MAP: Record<string, string> = {
  h1: "星核小鬼，过来一趟。",
  h2: "{NICKNAME}，模拟宇宙的数据很有趣。",
  h3: "只有中文的行。",
  h4: "", // empty rows never index
};

const EN_MAP: Record<string, string> = {
  h1: "Stellaron twerp, come here for a second.",
  h2: "{NICKNAME}, the Simulated Universe data is fascinating.",
  // h3 deliberately missing
};

const index = buildAlignmentIndex(CN_MAP);
const at = "2026-07-14T00:00:00.000Z";

describe("normalizeForAlignment", () => {
  it("collapses whitespace, punctuation, markup, and the NICKNAME template", () => {
    expect(normalizeForAlignment("「星核小鬼」， 过来一趟。")).toBe(
      normalizeForAlignment("星核小鬼，过来 一趟"),
    );
    expect(normalizeForAlignment("<i>{NICKNAME}</i>你好")).toBe(
      normalizeForAlignment("开拓者你好"),
    );
  });
});

describe("alignChunk", () => {
  it("exact: chunk text IS a TextMap line (after trim)", () => {
    const out = alignChunk(
      { chunkId: "c1", text: " 星核小鬼，过来一趟。 " },
      index,
      EN_MAP,
      "en",
      at,
    );
    expect(out).toEqual({
      kind: "aligned",
      translation: {
        chunkId: "c1",
        lang: "en",
        text: "Stellaron twerp, come here for a second.",
        textmapHash: "h1",
        matchKind: "exact",
        alignedAt: at,
      },
    });
  });

  it("normalized: wiki-variance punctuation and a rendered player alias still match", () => {
    // The wiki corpus renders {NICKNAME} as 开拓者 and drops the period.
    const out = alignChunk(
      { chunkId: "c2", text: "开拓者，模拟宇宙的数据很有趣" },
      index,
      EN_MAP,
      "en",
      at,
    );
    expect(out.kind).toBe("aligned");
    if (out.kind === "aligned") {
      expect(out.translation.matchKind).toBe("normalized");
      expect(out.translation.textmapHash).toBe("h2");
      // Stored text is the RAW official line, never a normalized form.
      expect(out.translation.text).toContain("{NICKNAME}");
    }
  });

  it("unmatched: wiki-composited text matches no line", () => {
    expect(
      alignChunk(
        { chunkId: "c3", text: "两句拼接 在一起的维基文本" },
        index,
        EN_MAP,
        "en",
        at,
      ),
    ).toEqual({ kind: "unmatched", chunkId: "c3" });
  });

  it("no_target_line: CN matched but the target map lacks the hash", () => {
    expect(
      alignChunk(
        { chunkId: "c4", text: "只有中文的行。" },
        index,
        EN_MAP,
        "en",
        at,
      ),
    ).toEqual({ kind: "no_target_line", chunkId: "c4" });
  });
});
