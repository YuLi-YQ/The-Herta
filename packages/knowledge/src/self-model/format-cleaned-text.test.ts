import { describe, expect, it } from "vitest";
import type { ParsedDocument } from "../html/parse-html.js";
import { formatCleanedText } from "./format-cleaned-text.js";

function doc(over: Partial<ParsedDocument>): ParsedDocument {
  return {
    title: "test",
    blocks: [],
    ...over,
  };
}

describe("formatCleanedText", () => {
  it("emits title as a top-level header", () => {
    const out = formatCleanedText(doc({ title: "大黑塔" }));
    expect(out).toContain("== 大黑塔 ==");
  });

  it("emits paragraphs as plain lines", () => {
    const out = formatCleanedText(
      doc({
        blocks: [
          { kind: "paragraph", sectionPath: [], text: "She works alone." },
          { kind: "paragraph", sectionPath: [], text: "She has many dolls." },
        ],
      }),
    );
    expect(out).toContain("She works alone.");
    expect(out).toContain("She has many dolls.");
  });

  it("emits dialogue with speaker prefix", () => {
    const out = formatCleanedText(
      doc({
        blocks: [
          {
            kind: "dialogue",
            sectionPath: [],
            speaker: "黑塔",
            text: "你来这里看实验吗？",
          },
        ],
      }),
    );
    expect(out).toContain("[黑塔] 你来这里看实验吗？");
  });

  it("emits section headers when sectionPath changes", () => {
    const out = formatCleanedText(
      doc({
        blocks: [
          { kind: "paragraph", sectionPath: ["概述"], text: "intro" },
          { kind: "paragraph", sectionPath: ["故事"], text: "story" },
        ],
      }),
    );
    expect(out).toMatch(/-- 概述 --[\s\S]*intro[\s\S]*-- 故事 --[\s\S]*story/);
  });

  it("emits nested section path with > separator", () => {
    const out = formatCleanedText(
      doc({
        blocks: [
          { kind: "paragraph", sectionPath: ["故事", "童年"], text: "x" },
        ],
      }),
    );
    expect(out).toContain("-- 故事 > 童年 --");
  });

  it("does not repeat the same section header for consecutive blocks in the same section", () => {
    const out = formatCleanedText(
      doc({
        blocks: [
          { kind: "paragraph", sectionPath: ["概述"], text: "a" },
          { kind: "paragraph", sectionPath: ["概述"], text: "b" },
        ],
      }),
    );
    const headerCount = (out.match(/-- 概述 --/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it("handles list_item with bullet prefix", () => {
    const out = formatCleanedText(
      doc({
        blocks: [{ kind: "list_item", sectionPath: [], text: "item" }],
      }),
    );
    expect(out).toContain("- item");
  });

  it("handles blockquote with > prefix", () => {
    const out = formatCleanedText(
      doc({
        blocks: [{ kind: "blockquote", sectionPath: [], text: "quoted" }],
      }),
    );
    expect(out).toContain("> quoted");
  });

  it("emits empty string for an empty document", () => {
    expect(formatCleanedText(doc({ title: "", blocks: [] }))).toBe("");
  });

  it("trims trailing whitespace on each line", () => {
    const out = formatCleanedText(
      doc({
        blocks: [
          { kind: "paragraph", sectionPath: [], text: "trailing space   " },
        ],
      }),
    );
    expect(out).toContain("trailing space");
    expect(out).not.toContain("trailing space   ");
  });
});
