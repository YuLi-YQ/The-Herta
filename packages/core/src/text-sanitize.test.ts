import { describe, expect, it } from "vitest";
import { stripDisplayUnsafe } from "./text-sanitize.js";

// Hostile inputs are built with String.fromCharCode so this FILE stays
// printable text (raw C0 bytes would make git treat it as binary).
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);
const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const BOM = String.fromCharCode(0xfeff);
const RLO = String.fromCharCode(0x202e);
const LRE = String.fromCharCode(0x202a);
const PDF = String.fromCharCode(0x202c);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
const CR = String.fromCharCode(0x0d);
const CSI1 = String.fromCharCode(0x9b); // one-char C1 CSI
const LRM = String.fromCharCode(0x200e);
const LSEP = String.fromCharCode(0x2028);
const PSEP = String.fromCharCode(0x2029);
const WJ = String.fromCharCode(0x2060); // word joiner — FEFF's successor
const IT = String.fromCharCode(0x2062); // invisible times
const HI_SURR = String.fromCharCode(0xd83d); // unpaired high surrogate
const TAG_A = String.fromCodePoint(0xe0041); // Unicode Tag block
const TAG_CANCEL = String.fromCodePoint(0xe007f);

describe("stripDisplayUnsafe", () => {
  it("strips ANSI escape introducers (ESC/CSI at the source)", () => {
    expect(stripDisplayUnsafe(`${ESC}[31mred${ESC}[0m`)).toBe("[31mred[0m");
    expect(stripDisplayUnsafe(`${ESC}]0;title${BEL}`)).toBe("]0;title");
  });

  it("strips C0 controls and DEL but keeps newline and tab", () => {
    expect(stripDisplayUnsafe(`a${NUL}b${BEL}c${DEL}d`)).toBe("abcd");
    expect(stripDisplayUnsafe("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it("normalizes CRLF to LF (CR is stripped)", () => {
    expect(stripDisplayUnsafe(`a${CR}\nb${CR}`)).toBe("a\nb");
  });

  it("strips bidi overrides and isolates (RLO display spoofing)", () => {
    expect(stripDisplayUnsafe(`${RLO}reversed`)).toBe("reversed");
    expect(stripDisplayUnsafe(`${LRI}iso${PDI}late`)).toBe("isolate");
    expect(stripDisplayUnsafe(`${LRE}x${PDF}`)).toBe("x");
  });

  it("strips zero-width ZWSP/ZWNJ/BOM but preserves ZWJ (emoji)", () => {
    expect(stripDisplayUnsafe(`@${ZWSP}板砖`)).toBe("@板砖");
    expect(stripDisplayUnsafe(`a${ZWNJ}b${BOM}c`)).toBe("abc");
    // Family emoji: three code points joined by ZWJ must survive intact.
    const family = ["👨", ZWJ, "👩", ZWJ, "👧"].join("");
    expect(stripDisplayUnsafe(family)).toBe(family);
  });

  it("strips the C1 block (one-char CSI/OSC introducers)", () => {
    expect(stripDisplayUnsafe(`a${CSI1}31mb`)).toBe("a31mb");
  });

  it("strips LRM/RLM and line/paragraph separators", () => {
    expect(stripDisplayUnsafe(`a${LRM}b${LSEP}c${PSEP}d`)).toBe("abcd");
  });

  it("strips word joiner + invisible operators (the WJ marker smuggle, 2026-07-09)", () => {
    // A WJ smuggled inside a marker must strip down to the LITERAL marker,
    // so the escape layer's break pass can neutralize it (pre-fix, the
    // obfuscated form passed through untouched — the ZWSP smuggle replayed
    // one codepoint over).
    expect(stripDisplayUnsafe(`（/开拓者${WJ} 说）`)).toBe("（/开拓者 说）");
    expect(stripDisplayUnsafe(`a${IT}b`)).toBe("ab");
  });

  it("strips the Unicode Tag block (hidden-instruction channel)", () => {
    expect(stripDisplayUnsafe(`hi${TAG_A}${TAG_CANCEL}there`)).toBe("hithere");
    // Deliberate trade-off: an emoji TAG SEQUENCE loses its tag chars and
    // falls back to the base flag. Built from code points — the tag chars
    // are invisible and must not sit in the source literally.
    const scotlandFlag =
      "🏴" +
      [0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f]
        .map((c) => String.fromCodePoint(c))
        .join("");
    expect(stripDisplayUnsafe(scotlandFlag)).toBe("🏴");
  });

  it("strips lone surrogates but never halves of a valid pair", () => {
    expect(stripDisplayUnsafe(`a${HI_SURR}b`)).toBe("ab");
    // 🚀 is a valid surrogate PAIR — one astral code point, untouched.
    expect(stripDisplayUnsafe("a🚀b")).toBe("a🚀b");
  });

  it("is the identity for normal prose, CJK, and astral emoji", () => {
    const texts = [
      "黑塔女士，你好。今天天气不错。",
      "Fix the parser in packages/core/src/foo.ts.",
      "混合 CJK + ASCII 以及 emoji 🚀🧪",
      "（我 说）markers are NOT this module's concern（/我 说）",
    ];
    for (const t of texts) {
      expect(stripDisplayUnsafe(t)).toBe(t);
    }
  });

  it("is idempotent", () => {
    const hostile = `${ESC}[2J${RLO}@${ZWSP}板砖${CR}\n${NUL} done`;
    const once = stripDisplayUnsafe(hostile);
    expect(stripDisplayUnsafe(once)).toBe(once);
  });
});
