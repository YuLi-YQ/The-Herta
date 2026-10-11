import { stripDisplayUnsafe } from "@herta/core/text-sanitize";
import { describe, expect, it } from "vitest";
import { createIncrementalScrubber } from "./incremental-strip.js";

/** Unsafe-laden corpus: bidi override, an ANSI color introducer (ESC),
 *  ZWSP, plus normal prose, an emoji pair (must SURVIVE), and a
 *  ZWJ-joined family sequence (ZWJ is deliberately preserved). */
const CORPUS = `你好\u202E呀，看 \u001B[31m这段\u200B文字 —— emoji: \u{1F600} 家庭: \u{1F468}\u200D\u{1F469}\u200D\u{1F466} 完。`;

describe("createIncrementalScrubber — equivalence with stripDisplayUnsafe", () => {
  it("every prefix (UTF-16 slicing — pairs split mid-delta) equals the batch scrub", () => {
    const scrub = createIncrementalScrubber();
    for (let end = 0; end <= CORPUS.length; end++) {
      const prefix = CORPUS.slice(0, end);
      expect(scrub.next(prefix).text).toBe(stripDisplayUnsafe(prefix));
    }
  });

  it("a pair completing across the append boundary is kept, not stripped", () => {
    const scrub = createIncrementalScrubber();
    // "a" + high surrogate: batch strips the LONE half.
    expect(scrub.next("a\uD83D").text).toBe("a");
    // The low half arrives: the pair is now valid and must survive intact.
    expect(scrub.next("a\u{1F600}").text).toBe("a\u{1F600}");
  });

  it("a lone high surrogate followed by a NON-low append stays stripped", () => {
    const scrub = createIncrementalScrubber();
    scrub.next("a\uD83D");
    expect(scrub.next("a\uD83Db").text).toBe(stripDisplayUnsafe("a\uD83Db"));
    expect(scrub.next("a\uD83Db").text).toBe("ab");
  });

  it("null resets; a shrink or replacement re-derives from scratch", () => {
    const scrub = createIncrementalScrubber();
    scrub.next(CORPUS);
    expect(scrub.next(null).text).toBeNull();
    expect(scrub.next("新\u202E文").text).toBe("新文");
    // Shrink (retract): non-append input, still batch-equal.
    expect(scrub.next("新").text).toBe("新");
    // Replacement: unrelated text.
    expect(scrub.next("另一个\u200B回复").text).toBe("另一个回复");
  });

  it("append fast path scans only the suffix", () => {
    const scrub = createIncrementalScrubber();
    scrub.next("abc");
    expect(scrub.next("abcdef").scanned).toBe(3);
    // Same text again: nothing to scan.
    expect(scrub.next("abcdef").scanned).toBe(0);
  });
});
