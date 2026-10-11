import { describe, expect, it } from "vitest";
import type { CanonDocumentKind } from "../schema.js";
import { chunkParsedDocument, classifyDocumentKind } from "./chunker.js";

describe("classifyDocumentKind", () => {
  it.each<[string, CanonDocumentKind]>([
    ["data/角色图鉴/078_黑塔.html", "character_profile"],
    ["data/plot_html/开拓续闻/001_x.html", "mission_dialogue"],
    ["data/plot_html/模拟宇宙/test.html", "simulated_universe"],
    ["data/book_html/013_黑塔的手稿.html", "book_readable"],
    ["data/星海纪闻/abc.html", "world_lore"],
    ["data/编年史/x.html", "chronology"],
    ["data/other/x.html", "unknown"],
  ])("%s -> %s", (path, kind) => {
    expect(classifyDocumentKind(path)).toBe(kind);
  });
});

describe("chunkParsedDocument", () => {
  it("emits one chunk per non-empty block with stable ordinals", () => {
    const chunks = chunkParsedDocument(
      {
        title: "T",
        blocks: [
          { kind: "paragraph", sectionPath: ["A"], text: "alpha" },
          {
            kind: "dialogue",
            sectionPath: ["A"],
            speaker: "黑塔",
            text: "beta",
          },
        ],
      },
      { documentId: "d1" },
    );
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.ordinal).toBe(0);
    expect(chunks[1]?.ordinal).toBe(1);
    expect(chunks[1]?.isDialogue).toBe(true);
    expect(chunks[1]?.speaker).toBe("黑塔");
  });

  it("sets a non-zero quality score on substantive paragraphs", () => {
    const chunks = chunkParsedDocument(
      {
        title: "T",
        blocks: [
          {
            kind: "paragraph",
            sectionPath: [],
            text: "黑塔本人坐着研究人偶。",
          },
        ],
      },
      { documentId: "d1" },
    );
    expect(chunks[0]?.qualityScore).toBeGreaterThan(0);
  });

  it("computes a stable text_hash per chunk", () => {
    const args = {
      title: "T",
      blocks: [
        { kind: "paragraph" as const, sectionPath: [], text: "stable text" },
      ],
    };
    const a = chunkParsedDocument(args, { documentId: "d1" });
    const b = chunkParsedDocument(args, { documentId: "d1" });
    expect(a[0]?.textHash).toBe(b[0]?.textHash);
  });
});
