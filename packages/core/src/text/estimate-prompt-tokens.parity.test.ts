import { describe, expect, it } from "vitest";
import { estimatePromptTokens } from "./estimate-prompt-tokens.js";

const isHan = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0xf900 && cp <= 0xfaff);

/** The iterator form (string iterator, one allocation per code point) —
 *  the arithmetic the index loop must reproduce exactly. Han ideographs
 *  0.65 each (2026-09-21, measured), every other non-ASCII code point 1,
 *  ASCII runs ÷4 rounded up per run. */
function reference(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  let han = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0x7f) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
      if (isHan(cp)) han += 1;
      else tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4) + Math.ceil((han * 13) / 20);
}

describe("estimatePromptTokens — index-loop parity with the iterator form", () => {
  const samples = [
    "",
    "a",
    "abcd",
    "abcde",
    "汉",
    "汉字测试",
    "mixed 汉字 and ascii 1234567 tails",
    "😀",
    "😀😀😀",
    "emoji 😀 inside 中 text",
    "𠀀 CJK Ext-B and 한글 and Кириллица and العربية",
    "a😀b", // a surrogate pair between ASCII
    "\uD83D", // a lone high surrogate at the end
    "\uDE00", // a lone low surrogate
    "\uD83Dx", // a high surrogate not followed by a low one
    "x".repeat(1000),
    "汉".repeat(1000),
    `${"abc汉".repeat(300)}😀`,
    "（我 说）嗯，交给板砖。", // fullwidth punctuation beside Han
    "㐀豈", // Extension A + a compatibility ideograph
  ];

  it("matches the reference on every sample", () => {
    for (const s of samples) {
      expect(estimatePromptTokens(s), JSON.stringify(s)).toBe(reference(s));
    }
  });

  it("counts a surrogate pair once and an ASCII run ÷4 at the boundaries", () => {
    expect(estimatePromptTokens("😀")).toBe(1);
    expect(estimatePromptTokens("汉")).toBe(1);
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcde")).toBe(2);
    expect(estimatePromptTokens("ab汉cd")).toBe(3);
  });
});

describe("the Han weight (2026-09-21, ADR 0068 §9)", () => {
  it("a Han ideograph is 0.65 token, rounded up once per text", () => {
    expect(estimatePromptTokens("汉".repeat(1000))).toBe(650);
    expect(estimatePromptTokens("汉".repeat(3))).toBe(2); // ceil(1.95)
    expect(estimatePromptTokens("㐀".repeat(100))).toBe(65); // Extension A
    expect(estimatePromptTokens("豈".repeat(100))).toBe(65); // compatibility
  });

  it("ONLY the measured blocks get it — what nobody measured stays at the conservative 1", () => {
    expect(estimatePromptTokens("，。！？（）".repeat(100))).toBe(600); // CJK punctuation
    expect(estimatePromptTokens("ＡＢＣ".repeat(100))).toBe(300); // fullwidth forms
    expect(estimatePromptTokens("かな".repeat(100))).toBe(200); // kana
    expect(estimatePromptTokens("한글".repeat(100))).toBe(200); // Hangul
    expect(estimatePromptTokens("𠀀".repeat(100))).toBe(100); // Ext-B, a surrogate pair
    expect(estimatePromptTokens("Кириллица")).toBe(9);
  });

  it("lands near the API's count on the measured samples", () => {
    // Character classes of three of Herta's Chinese prompt files with the
    // `prompt_tokens` the API reported for them (2026-09-21, identical on
    // deepseek-flash and deepseek-v4-pro). Rebuilt from the class counts —
    // Han + other non-ASCII at 1 + ASCII in runs of ~2, the files' real
    // shape — so the pin needs no fixture file and no network.
    const measured = [
      { name: "HertaBio", han: 8037, punct: 1158, ascii: 356, api: 6028 },
      { name: "HertaGuide", han: 3159, punct: 685, ascii: 588, api: 2785 },
      { name: "EnvSet", han: 2844, punct: 377, ascii: 197, api: 2124 },
    ];
    for (const m of measured) {
      // Interleave so the ASCII falls in short runs, as it does in prose.
      const runs = Math.ceil(m.ascii / 2);
      const hanPerRun = Math.floor(m.han / runs);
      let text = "";
      for (let i = 0; i < runs; i += 1) text += `${"汉".repeat(hanPerRun)}ab`;
      text += "汉".repeat(m.han - hanPerRun * runs);
      text += "，".repeat(m.punct);
      const ratio = estimatePromptTokens(text) / m.api;
      // 1 token per Han put these at 1.45–1.59; the weight puts them within
      // a sixth of the truth, on the conservative side.
      expect(ratio, m.name).toBeGreaterThan(0.95);
      expect(ratio, m.name).toBeLessThan(1.2);
    }
  });
});
