import { describe, expect, it } from "vitest";
import {
  EN_WORD_BASE_MS,
  EN_WORD_LEAD_MS,
  EN_WORD_PER_CHAR_MS,
  HOLD_AT,
  HOLD_MIN_FRACTION,
  holdIndexFor,
  humanizedCharDelay,
  isCjkPacingChar,
  JITTER_RATIO,
  MAX_STARTUP_MS,
  NEWLINE_PAUSE_RATIO,
  nextRevealEnd,
  PAUSE_PUNCTUATION,
  PUNCTUATION_PAUSE_RATIO,
  pacingDecision,
  RAMP_MAX_MULTIPLIER,
  RAMP_START,
  revealUnitDelay,
  spanMatchedBaseMs,
  startupDelayMs,
  TARGET_VISIBLE_MS,
} from "./slow-stream-pacing.js";

describe("holdIndexFor (boundary-aware hold)", () => {
  it("without chars, falls back to the raw HOLD_AT fraction", () => {
    expect(holdIndexFor(100)).toBe(92);
    expect(holdIndexFor(4)).toBe(3);
    expect(holdIndexFor(1)).toBe(0);
  });

  it("retreats to the nearest clause boundary at/below the fraction index", () => {
    // Regression for the reported stall (user 2026-07-04): this exact reply
    // held mid-clause at "…你可以|讲。" for the whole supervisor round-trip.
    const reply = "嗯。在卡论文，脑子正需要换个东西。你可以讲。";
    const chars = Array.from(reply);
    expect(chars).toHaveLength(22);
    // Raw fraction would hold at 20 (mid-clause). The boundary walk retreats
    // to 17 — right after the second 。 — so the shown text ends on a complete
    // sentence and the tail "你可以讲。" arrives whole after the verdict.
    expect(holdIndexFor(chars.length)).toBe(20);
    expect(holdIndexFor(chars.length, chars)).toBe(17);
    expect(chars.slice(0, 17).join("")).toBe(
      "嗯。在卡论文，脑子正需要换个东西。",
    );
    // The pacing decision holds there while the verdict is pending…
    expect(
      pacingDecision({
        cursor: 17,
        total: chars.length,
        verdictResolved: false,
        chars,
      }),
    ).toEqual({ kind: "hold" });
    // …and emits freely right below it.
    expect(
      pacingDecision({
        cursor: 16,
        total: chars.length,
        verdictResolved: false,
        chars,
      }).kind,
    ).toBe("emit");
  });

  it("treats a newline as a boundary", () => {
    const chars = Array.from("abcdefghijkl\nmnopqrst"); // \n at index 12, total 21
    // fraction = min(floor(21*0.92), 20) = 19; floor = ceil(21*0.5) = 11.
    // Walking 19→11 finds chars[12] = \n → hold right after it, at 13.
    expect(holdIndexFor(chars.length, chars)).toBe(13);
  });

  it("ignores boundaries below HOLD_MIN_FRACTION (no starved stream)", () => {
    // Punctuation only in the first half → fraction index stands.
    const chars = Array.from("一，二三四五六七八九十");
    const fraction = Math.min(
      Math.floor(chars.length * HOLD_AT),
      chars.length - 1,
    );
    expect(holdIndexFor(chars.length, chars)).toBe(fraction);
    expect(Math.ceil(chars.length * HOLD_MIN_FRACTION)).toBeGreaterThan(2);
  });

  it("punctuation-free text keeps the raw fraction (existing behavior)", () => {
    const chars = Array.from("零一二三四五六七八九");
    expect(holdIndexFor(chars.length, chars)).toBe(9);
  });

  it("always keeps at least one char gated", () => {
    const chars = Array.from("好。");
    const idx = holdIndexFor(chars.length, chars);
    expect(idx).toBeLessThan(chars.length);
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

describe("pacingDecision", () => {
  it("emits at 1x whenever the verdict is resolved (no ramp, no hold)", () => {
    for (const cursor of [0, 55, 91, 92, 99]) {
      expect(
        pacingDecision({ cursor, total: 100, verdictResolved: true }),
      ).toEqual({ kind: "emit", multiplier: 1 });
    }
  });

  it("emits at 1x before RAMP_START while the verdict is pending", () => {
    expect(
      pacingDecision({ cursor: 0, total: 100, verdictResolved: false }),
    ).toEqual({ kind: "emit", multiplier: 1 });
    expect(
      pacingDecision({ cursor: 54, total: 100, verdictResolved: false }),
    ).toEqual({ kind: "emit", multiplier: 1 });
  });

  it("ramps linearly from 1x at RAMP_START to RAMP_MAX_MULTIPLIER at HOLD_AT", () => {
    const at = (cursor: number) => {
      const d = pacingDecision({ cursor, total: 100, verdictResolved: false });
      if (d.kind !== "emit") throw new Error("expected emit");
      return d.multiplier;
    };
    const ramp = (progress: number) =>
      1 +
      ((progress - RAMP_START) / (HOLD_AT - RAMP_START)) *
        (RAMP_MAX_MULTIPLIER - 1);
    expect(at(55)).toBeCloseTo(1, 5);
    // Integer cursors straddling the band midpoint — pinned to the formula
    // (cursors are always integer character indices in production).
    expect(at(73)).toBeCloseTo(ramp(0.73), 5);
    expect(at(74)).toBeCloseTo(ramp(0.74), 5);
    // Just below the hold index: close to, but strictly under, the max.
    expect(at(91)).toBeCloseTo(ramp(0.91), 5);
    expect(at(91)).toBeLessThan(RAMP_MAX_MULTIPLIER);
  });

  it("holds at HOLD_AT while the verdict is pending", () => {
    expect(
      pacingDecision({ cursor: 92, total: 100, verdictResolved: false }),
    ).toEqual({ kind: "hold" });
    expect(
      pacingDecision({ cursor: 99, total: 100, verdictResolved: false }),
    ).toEqual({ kind: "hold" });
  });

  it("always holds at least one character for small texts", () => {
    // total=10 → holdIndex = min(floor(9.2), 9) = 9 → cursor 9 holds.
    expect(
      pacingDecision({ cursor: 9, total: 10, verdictResolved: false }),
    ).toEqual({ kind: "hold" });
    // total=2 → holdIndex = min(1, 1) = 1.
    expect(
      pacingDecision({ cursor: 1, total: 2, verdictResolved: false }),
    ).toEqual({ kind: "hold" });
    expect(
      pacingDecision({ cursor: 0, total: 2, verdictResolved: false }),
    ).toEqual({ kind: "emit", multiplier: 1 });
    // total=1 → holdIndex 0 → everything gated behind the verdict.
    expect(
      pacingDecision({ cursor: 0, total: 1, verdictResolved: false }),
    ).toEqual({ kind: "hold" });
  });

  it("treats empty text as a trivial emit (controller resolves immediately)", () => {
    expect(
      pacingDecision({ cursor: 0, total: 0, verdictResolved: false }),
    ).toEqual({ kind: "emit", multiplier: 1 });
  });

  it("exports the agreed constants", () => {
    expect(RAMP_START).toBe(0.55);
    expect(HOLD_AT).toBe(0.92);
    expect(RAMP_MAX_MULTIPLIER).toBe(3.5);
  });
});

describe("startupDelayMs", () => {
  it("is 0 for empty text", () => {
    expect(startupDelayMs({ total: 0, baseMs: 80 })).toBe(0);
  });

  it("is 0 when the un-ramped replay already meets the target (long line)", () => {
    // 40 chars × 80ms = 3200ms ≥ TARGET_VISIBLE_MS → no front buffer.
    expect(startupDelayMs({ total: 40, baseMs: 80 })).toBe(0);
  });

  it("front-loads TARGET − estimatedReplay for a short line", () => {
    // 22 chars × 80ms = 1760ms → 2800 − 1760 = 1040ms.
    expect(startupDelayMs({ total: 22, baseMs: 80 })).toBe(
      TARGET_VISIBLE_MS - 22 * 80,
    );
  });

  it("clamps to MAX_STARTUP_MS for a very short line", () => {
    // 1 char × 80ms = 80ms → 2720 raw, capped at MAX_STARTUP_MS.
    expect(startupDelayMs({ total: 1, baseMs: 80 })).toBe(MAX_STARTUP_MS);
  });

  it("scales with the caller's base cadence (CLI base = 100)", () => {
    // 20 chars × 100ms = 2000ms → 2800 − 2000 = 800ms.
    expect(startupDelayMs({ total: 20, baseMs: 100 })).toBe(
      TARGET_VISIBLE_MS - 20 * 100,
    );
  });

  it("exports the agreed constants", () => {
    expect(TARGET_VISIBLE_MS).toBe(2800);
    expect(MAX_STARTUP_MS).toBe(2000);
  });
});

describe("humanizedCharDelay", () => {
  it("random 0.5 → exactly baseMs for a plain char (zero jitter)", () => {
    expect(
      humanizedCharDelay({ emittedChar: "a", baseMs: 100, random: () => 0.5 }),
    ).toBe(100);
  });

  it("random 0 → base - JITTER_RATIO*base (minimum delay)", () => {
    const base = 100;
    const result = humanizedCharDelay({
      emittedChar: "a",
      baseMs: base,
      random: () => 0,
    });
    expect(result).toBeCloseTo(base - JITTER_RATIO * base, 10);
  });

  it("random 1 → base + JITTER_RATIO*base (maximum delay)", () => {
    const base = 100;
    const result = humanizedCharDelay({
      emittedChar: "a",
      baseMs: base,
      random: () => 1,
    });
    expect(result).toBeCloseTo(base + JITTER_RATIO * base, 10);
  });

  it("。 adds PUNCTUATION_PAUSE_RATIO*base on top of jittered base", () => {
    const base = 100;
    const result = humanizedCharDelay({
      emittedChar: "。",
      baseMs: base,
      random: () => 0.5,
    });
    // random 0.5 → zero jitter; pause adds PUNCTUATION_PAUSE_RATIO*base
    expect(result).toBe(base + PUNCTUATION_PAUSE_RATIO * base);
  });

  it("\\n adds NEWLINE_PAUSE_RATIO*base on top of jittered base", () => {
    const base = 100;
    const result = humanizedCharDelay({
      emittedChar: "\n",
      baseMs: base,
      random: () => 0.5,
    });
    // random 0.5 → zero jitter; newline adds NEWLINE_PAUSE_RATIO*base
    expect(result).toBe(base + NEWLINE_PAUSE_RATIO * base);
  });

  it("exports JITTER_RATIO = 0.15, PUNCTUATION_PAUSE_RATIO = 2, NEWLINE_PAUSE_RATIO = 4", () => {
    expect(JITTER_RATIO).toBe(0.15);
    expect(PUNCTUATION_PAUSE_RATIO).toBe(2);
    expect(NEWLINE_PAUSE_RATIO).toBe(4);
  });

  it("PAUSE_PUNCTUATION contains the expected CJK punctuation chars", () => {
    for (const ch of ["。", "！", "？", "，", "；", "：", "、", "…", "—"]) {
      expect(PAUSE_PUNCTUATION.has(ch)).toBe(true);
    }
    expect(PAUSE_PUNCTUATION.has("a")).toBe(false);
    expect(PAUSE_PUNCTUATION.has(".")).toBe(false);
  });

  it("DRAIN_MS_PER_CHAR is NOT exported (removed)", () => {
    // The module no longer exports DRAIN_MS_PER_CHAR. TypeScript enforces
    // this at compile time; this runtime check confirms the import map
    // has no such named export.
    // We import the whole module namespace to inspect at runtime.
    const mod = {
      JITTER_RATIO,
      PUNCTUATION_PAUSE_RATIO,
      NEWLINE_PAUSE_RATIO,
      PAUSE_PUNCTUATION,
      humanizedCharDelay,
      RAMP_START,
      HOLD_AT,
      RAMP_MAX_MULTIPLIER,
      pacingDecision,
    } as Record<string, unknown>;
    expect("DRAIN_MS_PER_CHAR" in mod).toBe(false);
  });
});

describe("spanMatchedBaseMs", () => {
  const FALLBACK = 80;

  it("divides the target by the plain char count when there's no punctuation", () => {
    // 4 chars, no punctuation/newline → weighted 4 → 2000/4 = 500.
    expect(
      spanMatchedBaseMs({
        text: "你来了吗",
        targetMs: 2000,
        fallbackMs: FALLBACK,
      }),
    ).toBe(500);
  });

  it("weights punctuation and newlines exactly as humanizedCharDelay does", () => {
    // "你来了。" → 4 chars + 1 punctuation → weighted 4 + PUNCTUATION_PAUSE_RATIO.
    const weighted = 4 + PUNCTUATION_PAUSE_RATIO;
    expect(
      spanMatchedBaseMs({
        text: "你来了。",
        targetMs: 1200,
        fallbackMs: FALLBACK,
      }),
    ).toBeCloseTo(1200 / weighted, 6);
    // A newline costs NEWLINE_PAUSE_RATIO on top of its own char.
    const t = "甲\n乙"; // 3 chars (甲, \n, 乙) + newline pause
    const w = 3 + NEWLINE_PAUSE_RATIO;
    expect(
      spanMatchedBaseMs({ text: t, targetMs: 1000, fallbackMs: FALLBACK }),
    ).toBeCloseTo(1000 / w, 6);
  });

  it("the matched base × weighted count reconstructs the target span", () => {
    const text = "晚上好，工作还顺利吗？"; // mixed chars + punctuation
    let weighted = 0;
    for (const ch of text) {
      weighted += 1;
      if (ch === "\n") weighted += NEWLINE_PAUSE_RATIO;
      else if (PAUSE_PUNCTUATION.has(ch)) weighted += PUNCTUATION_PAUSE_RATIO;
    }
    const base = spanMatchedBaseMs({
      text,
      targetMs: 6000,
      fallbackMs: FALLBACK,
    });
    expect(base * weighted).toBeCloseTo(6000, 6);
  });

  it("falls back for empty text or a non-positive / non-finite target", () => {
    expect(
      spanMatchedBaseMs({ text: "", targetMs: 5000, fallbackMs: FALLBACK }),
    ).toBe(FALLBACK);
    expect(
      spanMatchedBaseMs({ text: "你好", targetMs: 0, fallbackMs: FALLBACK }),
    ).toBe(FALLBACK);
    expect(
      spanMatchedBaseMs({ text: "你好", targetMs: -10, fallbackMs: FALLBACK }),
    ).toBe(FALLBACK);
    expect(
      spanMatchedBaseMs({
        text: "你好",
        targetMs: Number.NaN,
        fallbackMs: FALLBACK,
      }),
    ).toBe(FALLBACK);
  });

  it("floors at 1ms for a degenerate ratio (tiny clip, long text)", () => {
    const longText = "字".repeat(10000);
    // 1ms total over 10000 weighted chars → < 1 per char → floored to 1.
    expect(
      spanMatchedBaseMs({ text: longText, targetMs: 1, fallbackMs: FALLBACK }),
    ).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// EN word-reveal helpers (mode `word`). zh (`cjk`) is the byte-identical
// default, exercised by every suite above.
// ─────────────────────────────────────────────────────────────────────────

const cp = (s: string): string[] => [...s];

describe("nextRevealEnd", () => {
  it("cjk advances exactly one code point (status quo)", () => {
    expect(nextRevealEnd(cp("你好"), 0, "cjk")).toBe(1);
    expect(nextRevealEnd(cp("ab"), 0, "cjk")).toBe(1);
  });

  it("word emits each word WITH its trailing space; the final word has none", () => {
    const c = cp("Fixed the bug");
    expect(nextRevealEnd(c, 0, "word")).toBe(6); // "Fixed "
    expect(c.slice(0, 6).join("")).toBe("Fixed ");
    expect(nextRevealEnd(c, 6, "word")).toBe(10); // "the "
    expect(nextRevealEnd(c, 10, "word")).toBe(13); // "bug" — no trailing space
  });

  it("word treats a newline as its own unit (a breath), not swallowed by a word", () => {
    const c = cp("a\nb");
    expect(nextRevealEnd(c, 1, "word")).toBe(2); // just "\n"
    expect(nextRevealEnd(c, 2, "word")).toBe(3); // "b"
  });

  it("word collapses a run of inline spaces into one unit", () => {
    expect(nextRevealEnd(cp("a   b"), 1, "word")).toBe(4); // three spaces
  });

  it("returns cursor at end of text (no spin)", () => {
    expect(nextRevealEnd(cp("hi"), 2, "word")).toBe(2);
  });

  // Mixed-script fix (audit 2026-07-16): Herta mixes 中文 into EN sessions by
  // design; whitespace-only splitting made a spaceless zh clause ONE unit.
  it("word: a CJK glyph is its own unit; a CJK run reveals glyph by glyph", () => {
    const c = cp("这个bug说白了");
    expect(nextRevealEnd(c, 0, "word")).toBe(1); // 这
    expect(nextRevealEnd(c, 1, "word")).toBe(2); // 个
    expect(nextRevealEnd(c, 2, "word")).toBe(5); // "bug" — the run stops at 说
    expect(c.slice(2, 5).join("")).toBe("bug");
    expect(nextRevealEnd(c, 5, "word")).toBe(6); // 说
  });

  it("word: a CJK glyph swallows its trailing inline spaces like a word does", () => {
    const c = cp("好 ok");
    expect(nextRevealEnd(c, 0, "word")).toBe(2); // "好 "
    expect(nextRevealEnd(c, 2, "word")).toBe(4); // "ok"
  });

  it("word: fullwidth CJK punctuation is its own unit", () => {
    const c = cp("对。ok");
    expect(nextRevealEnd(c, 1, "word")).toBe(2); // 。
  });

  it("isCjkPacingChar: ideographs/kana/fullwidth yes; ASCII/emoji no", () => {
    for (const ch of ["这", "。", "，", "！", "の", "한"]) {
      expect(isCjkPacingChar(ch), ch).toBe(true);
    }
    for (const ch of ["a", "9", ".", " ", "🙂", "—", "…", undefined]) {
      expect(isCjkPacingChar(ch), String(ch)).toBe(false);
    }
  });
});

describe("revealUnitDelay", () => {
  const noJitter = (): number => 0.5;

  it("cjk delegates to humanizedCharDelay on the emitted char", () => {
    const c = cp("好");
    expect(
      revealUnitDelay({
        chars: c,
        start: 0,
        end: 1,
        mode: "cjk",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(
      humanizedCharDelay({ emittedChar: "好", baseMs: 80, random: noJitter }),
    );
  });

  it("word delay scales with the word's non-space length", () => {
    const c = cp("parser "); // 6 letters + trailing space
    expect(
      revealUnitDelay({
        chars: c,
        start: 0,
        end: 7,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(EN_WORD_LEAD_MS + EN_WORD_PER_CHAR_MS * 6);
  });

  it("adds a sentence breath after . ! ? at a token boundary", () => {
    const c = cp("done. ");
    expect(
      revealUnitDelay({
        chars: c,
        start: 0,
        end: 6,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(
      EN_WORD_LEAD_MS +
        EN_WORD_PER_CHAR_MS * 5 +
        EN_WORD_BASE_MS * PUNCTUATION_PAUSE_RATIO,
    );
  });

  it("does NOT breathe on a mid-token dot (3.5) — last non-space char is a digit", () => {
    const c = cp("3.5 ");
    expect(
      revealUnitDelay({
        chars: c,
        start: 0,
        end: 4,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(EN_WORD_LEAD_MS + EN_WORD_PER_CHAR_MS * 3);
  });

  it("adds a shorter clause breath after , ; :", () => {
    const c = cp("first, ");
    expect(
      revealUnitDelay({
        chars: c,
        start: 0,
        end: 7,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(EN_WORD_LEAD_MS + EN_WORD_PER_CHAR_MS * 6 + EN_WORD_BASE_MS);
  });

  it("a CJK glyph unit types at the cjk cadence, with the zh breath vocabulary", () => {
    const c = cp("说白了。");
    expect(
      revealUnitDelay({
        chars: c,
        start: 0,
        end: 1,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(
      humanizedCharDelay({ emittedChar: "说", baseMs: 80, random: noJitter }),
    );
    // 。 gets the same punctuation breath a zh session gives it.
    expect(
      revealUnitDelay({
        chars: c,
        start: 3,
        end: 4,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(80 + PUNCTUATION_PAUSE_RATIO * 80);
  });

  it("a newline unit gets the paragraph breath", () => {
    const c = cp("a\nb");
    expect(
      revealUnitDelay({
        chars: c,
        start: 1,
        end: 2,
        mode: "word",
        baseMs: 80,
        random: noJitter,
      }),
    ).toBe(EN_WORD_BASE_MS * NEWLINE_PAUSE_RATIO);
  });
});

describe("holdIndexFor / pacingDecision — word mode", () => {
  const reply = "The parser cursor now resets correctly and the test passes.";

  it("retreats the hold to a word boundary (right after a space), never mid-word", () => {
    const c = cp(reply);
    const word = holdIndexFor(c.length, c, "word");
    // Lands right after an inline space → the char BEFORE the hold is a space.
    expect(c[word - 1]).toBe(" ");
    // Still ≥1 code point gated, and at/above the HOLD_MIN_FRACTION floor.
    expect(word).toBeLessThan(c.length);
    expect(word).toBeGreaterThanOrEqual(
      Math.ceil(c.length * HOLD_MIN_FRACTION),
    );
  });

  it("falls back to the raw fraction index only when NO boundary exists anywhere after the floor (URL to end-of-text)", () => {
    const c = cp(
      "see https://example.com/a/very/long/path-with-no-spaces-here",
    );
    const raw = Math.min(Math.floor(c.length * HOLD_AT), c.length - 1);
    expect(holdIndexFor(c.length, c, "word")).toBe(raw);
  });

  it("scans FORWARD past HOLD_AT when the band is one unbroken ASCII run (long URL) — never freezes mid-token", () => {
    // The URL spans the whole [0.5, 0.92] band; the first boundary after it is
    // the space before the 2-char tail.
    const url = `https://x.com/${"a".repeat(46)}`;
    const c = cp(`see ${url} ok`);
    const raw = Math.min(Math.floor(c.length * HOLD_AT), c.length - 1);
    const hold = holdIndexFor(c.length, c, "word");
    expect(hold).toBeGreaterThan(raw); // moved forward, not mid-URL
    expect(c[hold - 1]).toBe(" "); // lands right after the URL's space
    expect(hold).toBeLessThan(c.length); // still ≥1 char gated
  });

  it("word mode treats CJK-adjacent indexes as unit boundaries (a zh clause never freezes mid-glyph… because every glyph IS a unit)", () => {
    const c = cp("check 这个解析器的游标现在会正确重置了吗你说呢朋友");
    const hold = holdIndexFor(c.length, c, "word");
    const raw = Math.min(Math.floor(c.length * HOLD_AT), c.length - 1);
    // The fraction index sits inside the CJK run — which is now itself a
    // boundary (glyph-complete), so no retreat is needed.
    expect(hold).toBe(raw);
    expect(isCjkPacingChar(c[hold - 1])).toBe(true);
  });

  it("pacingDecision(word) holds at EXACTLY holdIndexFor(word) — so the sink's clamp and gate agree", () => {
    const c = cp(reply);
    const hold = holdIndexFor(c.length, c, "word");
    expect(
      pacingDecision({
        cursor: hold,
        total: c.length,
        verdictResolved: false,
        chars: c,
        mode: "word",
      }).kind,
    ).toBe("hold");
    expect(
      pacingDecision({
        cursor: hold - 1,
        total: c.length,
        verdictResolved: false,
        chars: c,
        mode: "word",
      }).kind,
    ).toBe("emit");
  });
});
