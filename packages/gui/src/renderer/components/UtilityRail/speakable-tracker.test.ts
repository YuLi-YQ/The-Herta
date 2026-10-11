import { describe, expect, it } from "vitest";
import { scanSpeakable } from "./speakable-text.js";
import { createSpeakableTracker } from "./speakable-tracker.js";

/** Deterministic PRNG (mulberry32) — fuzz cases must reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Replay every prefix through one tracker; the telescoped `grown` total and
 *  `last` must equal a fresh batch scan of the same prefix at every step —
 *  including the transient partial-line states the module doc warns about
 *  ("``" reads as prose until "```" completes; " " becomes a table row). */
function replay(text: string): void {
  const tracker = createSpeakableTracker();
  let total = 0;
  for (let end = 0; end <= text.length; end++) {
    const prefix = text.slice(0, end);
    const step = tracker.push(prefix);
    total += step.grown;
    const batch = scanSpeakable(prefix);
    expect(total).toBe(batch.count);
    expect(step.last).toBe(batch.last);
  }
}

describe("createSpeakableTracker — equivalence with scanSpeakable", () => {
  it("prose with punctuation and multi-line paragraphs", () => {
    replay("你好。\n这是第二行，带逗号，\n结尾……");
  });

  it("fences, including the partial-``` transient and text after the close", () => {
    replay("看这个：\n```ts\nconst x = 1;\n```\n就这样。");
  });

  it("an unclosed fence swallows the tail", () => {
    replay("先说。\n```py\nprint(1)\nprint(2)");
  });

  it("table rows, including the partial-pipe transient", () => {
    replay("表格：\n| a | b |\n| 1 | 2 |\n完。");
    replay("  | indented row\nafter");
  });

  it("whitespace-only lines count their chars but never set `last`", () => {
    replay("A\n   \nB");
  });

  it("a non-append input (shrink / replacement) resets and re-derives", () => {
    const tracker = createSpeakableTracker();
    let total = 0;
    total += tracker.push("一些文本。\n```\ncode").grown;
    expect(total).toBe(scanSpeakable("一些文本。\n```\ncode").count);
    // Replacement: the tracker rebases; the running total must land on the
    // new text's batch count (grown may be negative in between).
    total += tracker.push("换了。").grown;
    expect(total).toBe(scanSpeakable("换了。").count);
    total += tracker.push("").grown;
    expect(total).toBe(0);
  });

  it("fuzz: 200 seeded token soups, every prefix equals batch", () => {
    const tokens = [
      "字",
      "a",
      "。",
      "，",
      " ",
      "\n",
      "|",
      "`",
      "``",
      "```\n",
      "```ts\n",
      "  |",
      "\n\n",
    ];
    const rand = mulberry32(0xbeef);
    for (let round = 0; round < 200; round++) {
      const n = 2 + Math.floor(rand() * 16);
      let text = "";
      for (let k = 0; k < n; k++) {
        text += tokens[Math.floor(rand() * tokens.length)];
      }
      replay(text);
    }
  });
});
