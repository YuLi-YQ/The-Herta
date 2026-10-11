import { describe, expect, it } from "vitest";
import {
  createIncrementalSegmenter,
  MAX_SEGMENTS,
  segmentSpeech,
} from "./segment-speech.js";

describe("segmentSpeech — prose paragraph splits", () => {
  it("single paragraph → one prose segment", () => {
    expect(segmentSpeech("就一句话。")).toEqual([
      { kind: "prose", text: "就一句话。" },
    ]);
  });

  it("blank-line paragraphs → stacked prose segments", () => {
    expect(segmentSpeech("第一段。\n\n第二段。\n\n第三段。")).toEqual([
      { kind: "prose", text: "第一段。" },
      { kind: "prose", text: "第二段。" },
      { kind: "prose", text: "第三段。" },
    ]);
  });

  it("single newlines stay INSIDE one paragraph (pre-wrap owns them)", () => {
    expect(segmentSpeech("一行\n又一行")).toEqual([
      { kind: "prose", text: "一行\n又一行" },
    ]);
  });

  it("blank lines with stray spaces still split; extras collapse", () => {
    expect(segmentSpeech("a\n \n\nb")).toEqual([
      { kind: "prose", text: "a" },
      { kind: "prose", text: "b" },
    ]);
  });

  it("drops empty input and trailing blank runs", () => {
    expect(segmentSpeech("")).toEqual([]);
    expect(segmentSpeech("   \n\n  ")).toEqual([]);
    expect(segmentSpeech("尾巴。\n\n\n")).toEqual([
      { kind: "prose", text: "尾巴。" },
    ]);
  });

  it("preserves a @板砖 mention within its paragraph", () => {
    expect(segmentSpeech("这个交给 @板砖。\n\n我先睡了。")).toEqual([
      { kind: "prose", text: "这个交给 @板砖。" },
      { kind: "prose", text: "我先睡了。" },
    ]);
  });
});

describe("segmentSpeech — fences", () => {
  it("closed fence → prose, code, prose", () => {
    expect(
      segmentSpeech("看这段：\n```ts\nconst x = 1;\n```\n就这样。"),
    ).toEqual([
      { kind: "prose", text: "看这段：" },
      { kind: "code", text: "const x = 1;", lang: "ts" },
      { kind: "prose", text: "就这样。" },
    ]);
  });

  it("fence without a lang tag omits lang", () => {
    expect(segmentSpeech("```\nplain\n```")).toEqual([
      { kind: "code", text: "plain" },
    ]);
  });

  it("blank lines INSIDE a fence never split", () => {
    expect(segmentSpeech("```\nline1\n\nline2\n```")).toEqual([
      { kind: "code", text: "line1\n\nline2" },
    ]);
  });

  it("an UNCLOSED fence swallows the tail as one code segment", () => {
    expect(segmentSpeech("先说两句。\n```py\nprint(1)\nprint(2)")).toEqual([
      { kind: "prose", text: "先说两句。" },
      { kind: "code", text: "print(1)\nprint(2)", lang: "py" },
    ]);
  });

  it("an empty fence interior is dropped", () => {
    expect(segmentSpeech("前。\n```\n\n```\n后。")).toEqual([
      { kind: "prose", text: "前。" },
      { kind: "prose", text: "后。" },
    ]);
  });

  it("a lang-tagged ``` line inside a fence does NOT close it", () => {
    expect(segmentSpeech("```\nouter\n```ts\nstill inside\n```")).toEqual([
      { kind: "code", text: "outer\n```ts\nstill inside" },
    ]);
  });
});

describe("segmentSpeech — cap", () => {
  it(`folds overflow into the last segment at ${MAX_SEGMENTS}`, () => {
    const paras = Array.from({ length: 8 }, (_, i) => `第${i + 1}段。`);
    const out = segmentSpeech(paras.join("\n\n"));
    expect(out).toHaveLength(MAX_SEGMENTS);
    // The final segment carries everything from the fold point on — no
    // text is dropped.
    const tail = out[MAX_SEGMENTS - 1];
    expect(tail?.kind).toBe("prose");
    for (let i = MAX_SEGMENTS; i <= 8; i++) {
      expect(tail?.text).toContain(`第${i}段。`);
    }
    // Earlier segments intact.
    expect(out[0]).toEqual({ kind: "prose", text: "第1段。" });
  });

  it("a folded code segment keeps its fence markers so the text still reads as code", () => {
    const paras = [
      ...Array.from({ length: 5 }, (_, i) => `p${i + 1}`),
      "```\ncode tail\n```",
    ];
    const out = segmentSpeech(paras.join("\n\n"));
    expect(out).toHaveLength(MAX_SEGMENTS);
    expect(out[MAX_SEGMENTS - 1]?.text).toContain("```\ncode tail\n```");
  });
});

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

/** Building blocks chosen to hit every boundary rule: separators (blank and
 *  whitespace-only lines), fence opens (bare / lang-tagged / indented),
 *  bare-``` closes, lang-tagged non-closes inside fences, table-ish pipes,
 *  and enough plain tokens to exceed the fold cap. */
const FUZZ_TOKENS = [
  "字",
  "a",
  "。",
  " ",
  "\n",
  "\n\n",
  "\n \n",
  "```\n",
  "```ts\n",
  "  ```\n",
  "`x`",
  "|",
  "第段落内容较长一些的句子。\n\n",
];

describe("createIncrementalSegmenter — equivalence with segmentSpeech", () => {
  /** Replay every prefix of `text` through one segmenter instance and pin
   *  each step to the batch result. This IS the correctness contract: the
   *  incremental path may cache whatever it likes, but its output must be
   *  indistinguishable from re-running segmentSpeech on the full string. */
  function replay(text: string, stride = 1): void {
    const inc = createIncrementalSegmenter();
    for (let end = 0; end <= text.length; end += stride) {
      const prefix = text.slice(0, end);
      expect(inc.next(prefix).segments).toEqual(segmentSpeech(prefix));
    }
    // Always land exactly on the full text.
    expect(inc.next(text).segments).toEqual(segmentSpeech(text));
  }

  it("multi-paragraph prose with messy separators", () => {
    replay("第一段。\n\n第二段。\n \n\n第三段\n还是第三段。\n\n\n第四段。");
  });

  it("fences: closed, lang-tagged, indented close, unclosed tail", () => {
    replay("看这段：\n```ts\nconst x = 1;\n\nconst y = 2;\n  ```\n就这样。");
    replay("先说两句。\n```py\nprint(1)\nprint(2)");
    replay("```\nouter\n```ts\nstill inside\n```");
    replay("前。\n```\n\n```\n后。\n\n```json\n{}");
  });

  it("leading blanks, whitespace-only lines, lone fences", () => {
    replay("   \n\n  开头之前有空白。\n\n```\n");
    replay("\n\n\nA\n\nB");
    replay("```");
  });

  it("overflow past the fold cap, with code in the overflow", () => {
    const paras = Array.from({ length: 9 }, (_, i) => `第${i + 1}段落。`);
    paras.splice(6, 0, "```\ncode tail\n```");
    replay(paras.join("\n\n"));
  });

  it("one giant single paragraph (no freeze points) still matches", () => {
    replay("没有边界的一整段".repeat(60), 7);
  });

  it("a non-append input (shrink / replacement) resets and re-derives", () => {
    const inc = createIncrementalSegmenter();
    const grown = "AAA。\n\nBBB。\n\nCCC。";
    inc.next(grown);
    // Shrink (the retract morph erasing): every step must equal batch.
    for (let end = grown.length; end >= 0; end -= 3) {
      const prefix = grown.slice(0, end);
      expect(inc.next(prefix).segments).toEqual(segmentSpeech(prefix));
    }
    // Replacement (a fresh turn): unrelated text, straight to batch parity.
    expect(inc.next("完全不同的新回复。\n\n第二段。").segments).toEqual(
      segmentSpeech("完全不同的新回复。\n\n第二段。"),
    );
  });

  it("frozen segments keep their identity across ticks (the memo contract)", () => {
    const inc = createIncrementalSegmenter();
    const text = "AAA。\n\nBBB。\n\n```ts\ncode\n```\nCCC还在长";
    let prev: readonly unknown[] = [];
    for (let end = 0; end <= text.length; end++) {
      const step = inc.next(text.slice(0, end)).segments;
      // Every segment that existed last tick with the same VALUE must be
      // the same OBJECT — only the growing tail may be fresh.
      for (let k = 0; k < Math.min(prev.length, step.length) - 1; k++) {
        expect(step[k]).toBe(prev[k]);
      }
      prev = step;
    }
  });

  it("fuzz: 150 seeded token soups, every prefix equals batch", () => {
    const rand = mulberry32(0x5eed);
    for (let round = 0; round < 150; round++) {
      const n = 3 + Math.floor(rand() * 20);
      let text = "";
      for (let k = 0; k < n; k++) {
        text += FUZZ_TOKENS[Math.floor(rand() * FUZZ_TOKENS.length)];
      }
      replay(text);
    }
  });
});
