import { describe, expect, it } from "vitest";
import type { AntiPattern } from "../schema.js";
import { buildExtractionPrompt } from "./extract-prompt.js";

const ANTI_PATTERNS: AntiPattern[] = [
  {
    pattern: "She does not return 你好 greetings politely.",
    rationale: "Herta's voice is dismissive of casual greetings.",
    evidenceAbsenceClaim: "No 你好 greeting opener in 1173 voice chunks.",
  },
  {
    pattern: "She does not say 'I am Herta CLI' or any variant.",
    rationale: "The CLI is a tool, not her form.",
    evidenceAbsenceClaim: "No CLI-as-self framing in any canon source.",
  },
];

describe("buildExtractionPrompt", () => {
  it("returns systemPrompt and userPayload", () => {
    const out = buildExtractionPrompt({
      filename: "019_大黑塔.html",
      category: "character_page",
      cleanedText: "==大黑塔==\nShe is...",
      antiPatterns: ANTI_PATTERNS,
    });
    expect(typeof out.systemPrompt).toBe("string");
    expect(typeof out.userPayload).toBe("string");
    expect(out.systemPrompt.length).toBeGreaterThan(0);
    expect(out.userPayload.length).toBeGreaterThan(0);
  });

  it("system prompt is written in Chinese", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("任务");
    expect(out.systemPrompt).toContain("约束");
  });

  it("system prompt contains the doll-vs-self disambiguation (both languages)", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("大黑塔");
    expect(out.systemPrompt).toContain("人偶");
    expect(out.systemPrompt).toContain("doll");
    expect(out.systemPrompt).toContain("不是她本人");
  });

  it("system prompt contains the Madam Herta disambiguation", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("Madam Herta");
    expect(out.systemPrompt).toContain("IPC");
  });

  it("system prompt embeds every anti-pattern", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: ANTI_PATTERNS,
    });
    for (const ap of ANTI_PATTERNS) {
      expect(out.systemPrompt).toContain(ap.pattern);
    }
  });

  it("system prompt contains the JSON schema instruction", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain('"kind"');
    expect(out.systemPrompt).toContain("biography");
    expect(out.systemPrompt).toContain("philosophy");
    expect(out.systemPrompt).toContain("embodiment");
    expect(out.systemPrompt).toContain("relationship");
    expect(out.systemPrompt).toContain("harness_proprioception");
    expect(out.systemPrompt).toContain("anti_pattern");
    expect(out.systemPrompt).toContain("interaction_register");
    expect(out.systemPrompt).toContain("confidence");
  });

  it("system prompt forbids prose preamble or markdown fences", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("只输出 JSON");
    expect(out.systemPrompt).toContain("markdown 围栏");
  });

  it("system prompt instructs returning empty facts on irrelevant document", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain('"facts": []');
  });

  it("system prompt mandates Chinese-language prose output", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("prose 字段用中文写");
  });

  it("system prompt forbids extrapolation beyond the document", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).toContain("不要");
    expect(out.systemPrompt).toMatch(/(推断|外推|编造)/);
  });

  it("user payload includes filename and category", () => {
    const out = buildExtractionPrompt({
      filename: "082_x.html",
      category: "mission",
      cleanedText: "content",
      antiPatterns: [],
    });
    expect(out.userPayload).toContain("082_x.html");
    expect(out.userPayload).toContain("mission");
  });

  it("user payload includes the cleaned text", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "== 大黑塔 ==\n[黑塔] 你来看实验？",
      antiPatterns: [],
    });
    expect(out.userPayload).toContain("== 大黑塔 ==");
    expect(out.userPayload).toContain("[黑塔] 你来看实验？");
  });

  it("anti-pattern section omitted when array is empty (no leading bullet noise)", () => {
    const out = buildExtractionPrompt({
      filename: "x.html",
      category: "character_page",
      cleanedText: "x",
      antiPatterns: [],
    });
    expect(out.systemPrompt).not.toMatch(/^- $/m);
    expect(out.systemPrompt).not.toMatch(/^\* $/m);
  });
});
