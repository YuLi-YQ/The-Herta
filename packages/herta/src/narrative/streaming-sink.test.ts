import { describe, expect, it } from "vitest";
import type {
  ActorStreamingSink,
  LiveSlowStreamController,
  SlowStreamController,
} from "./streaming-sink.js";
import {
  safeEmitBoundary,
  stripDanglingStopPrefix,
  stripStopSequence,
} from "./streaming-sink.js";

describe("safeEmitBoundary", () => {
  it("returns 0 for empty buffer", () => {
    expect(safeEmitBoundary("", ["（/我 说）", "｜>"])).toBe(0);
  });

  it("returns buffer.length when no stop-sequence prefix matches the tail", () => {
    const buf = "你好，开拓者。";
    expect(safeEmitBoundary(buf, ["（/我 说）", "｜>"])).toBe(buf.length);
  });

  it("returns buffer.length when stop list is empty", () => {
    const buf = "anything";
    expect(safeEmitBoundary(buf, [])).toBe(buf.length);
  });

  it("holds the trailing char when it could be the start of a stop sequence", () => {
    // The buffer ends with "（" which could be the start of "（/我 说）".
    const buf = "好的（";
    const result = safeEmitBoundary(buf, ["（/我 说）", "｜>"]);
    expect(result).toBe(buf.length - 1); // hold the "（"
  });

  it("holds the trailing 2 chars when they match a longer stop prefix", () => {
    // The buffer ends with "（/" which matches the 2-char prefix of "（/我 说）".
    const buf = "好的（/";
    const result = safeEmitBoundary(buf, ["（/我 说）", "｜>"]);
    expect(result).toBe(buf.length - 2); // hold "（/"
  });

  it("holds the entire stop sequence when buffer ends with it", () => {
    // The buffer ends with the full stop sequence (provider sometimes emits it).
    const buf = "good content（/我 说）";
    const result = safeEmitBoundary(buf, ["（/我 说）", "｜>"]);
    expect(result).toBe(buf.length - "（/我 说）".length);
  });

  it("holds the trailing 1 char of an inline bracket stop", () => {
    // The buffer ends with "｜" which is the 1-char prefix of "｜>".
    const buf = '<｜read_file("foo.ts")｜';
    const result = safeEmitBoundary(buf, ["（/我 说）", "｜>"]);
    expect(result).toBe(buf.length - 1); // hold the "｜"
  });

  it("holds the entire inline-bracket stop when buffer ends with it", () => {
    const buf = '<｜read_file("foo.ts")｜>';
    const result = safeEmitBoundary(buf, ["（/我 说）", "｜>"]);
    expect(result).toBe(buf.length - "｜>".length);
  });

  it("prefers the longest matching tail across multiple stop sequences", () => {
    // Trailing "（" could be start of "（/我 说）" only. Hold 1 char.
    const buf = "abc（";
    expect(safeEmitBoundary(buf, ["（/我 说）", "｜>"])).toBe(buf.length - 1);
    // Trailing "（/我" could be the 3-char prefix of "（/我 说）". Hold 3 chars.
    const buf2 = "abc（/我";
    expect(safeEmitBoundary(buf2, ["（/我 说）", "｜>"])).toBe(buf2.length - 3);
  });

  it("does NOT hold chars that happen to match a stop INTERIOR (only prefixes)", () => {
    // "/" alone is NOT a prefix of any stop sequence (the first char is "（").
    const buf = "result: 1/2";
    expect(safeEmitBoundary(buf, ["（/我 说）", "｜>"])).toBe(buf.length);
  });
});

describe("stripStopSequence", () => {
  it("returns the buffer unchanged when stop sequence is absent", () => {
    expect(stripStopSequence("hello world", "（/我 说）")).toBe("hello world");
  });

  it("strips the trailing stop sequence", () => {
    expect(stripStopSequence("hello（/我 说）", "（/我 说）")).toBe("hello");
  });

  it("strips only the LAST occurrence (defensive against duplicates)", () => {
    expect(
      stripStopSequence("first（/我 说）middle（/我 说）", "（/我 说）"),
    ).toBe("first（/我 说）middle");
  });

  it("returns empty string when buffer IS the stop sequence", () => {
    expect(stripStopSequence("（/我 说）", "（/我 说）")).toBe("");
  });

  it("returns the buffer unchanged when stop is at position 0 but buffer is longer", () => {
    // lastIndexOf returns 0; slice(0, 0) returns "" — that's the strip.
    // This case represents "stop appeared at the very start" — pathological,
    // but the helper's contract is "everything before lastIndexOf(stop)".
    expect(stripStopSequence("（/我 说）trailing", "（/我 说）")).toBe("");
  });
});

describe("stripDanglingStopPrefix", () => {
  // The three stop sequences the v0.2 actor sends to DeepSeek completion.
  const STOPS = ["（/我 说）", "（/我 想）", "（开拓者 说）"] as const;

  it("strips a dangling 2-char close-marker prefix （/", () => {
    // The model started the speech close marker （/我 说） but the stream
    // finished after only （/ — the regression behind record 53e0e3c8.
    expect(stripDanglingStopPrefix("好的。（/", STOPS)).toBe("好的。");
  });

  it("strips a dangling 1-char prefix （", () => {
    expect(stripDanglingStopPrefix("好的。（", STOPS)).toBe("好的。");
  });

  it("strips the longest dangling prefix （/我", () => {
    expect(stripDanglingStopPrefix("好的。（/我", STOPS)).toBe("好的。");
  });

  it("leaves clean prose untouched", () => {
    expect(stripDanglingStopPrefix("你好，开拓者。", STOPS)).toBe(
      "你好，开拓者。",
    );
  });

  it("does not strip a trailing ） (not a prefix of any stop)", () => {
    // A closed full-width parenthetical legitimately ends in ）.
    expect(stripDanglingStopPrefix("（这是注释）", STOPS)).toBe("（这是注释）");
  });

  it("only touches the trailing tail, never an interior fragment", () => {
    // The （/ here is interior (followed by prose), not a dangling tail.
    expect(stripDanglingStopPrefix("（/不是结尾 还有字", STOPS)).toBe(
      "（/不是结尾 还有字",
    );
  });

  it("strips only the marker prefix, leaving the orphan newline for trim()", () => {
    expect(stripDanglingStopPrefix("补上？\n（/", STOPS)).toBe("补上？\n");
  });

  it("is a no-op when the stop list is empty", () => {
    expect(stripDanglingStopPrefix("好的。（/", [])).toBe("好的。（/");
  });

  it("strips a dangling user-tag prefix （开拓 too", () => {
    // Not just the close markers — any held stop prefix that never completed.
    expect(stripDanglingStopPrefix("说完了。（开拓", STOPS)).toBe("说完了。");
  });

  it("strips a COMPLETE trailing close marker as well", () => {
    // safeEmitBoundary holds the full marker, so the helper removes it too —
    // this is what lets callers apply it to the raw buffer.
    expect(stripDanglingStopPrefix("好的。（/我 说）", STOPS)).toBe("好的。");
  });

  it("stops at the complete-marker boundary, preserving prose （ before it", () => {
    // A lone full-width （ as prose, then the complete marker: the helper
    // holds only the marker (6 chars), never reaching into the prose （.
    expect(stripDanglingStopPrefix("开始（（/我 说）", STOPS)).toBe("开始（");
  });
});

describe("LiveSlowStreamController", () => {
  it("a conforming live controller exposes push/finish + terminal methods", () => {
    const calls: string[] = [];
    const controller: LiveSlowStreamController = {
      done: Promise.resolve(),
      pushToken: (t) => calls.push(`push:${t}`),
      finishInput: () => calls.push("finish"),
      fastForward: async () => {
        calls.push("ff");
      },
      cancelAndBackspace: async () => {
        calls.push("cancel");
      },
    };
    controller.pushToken("嗯");
    controller.finishInput();
    expect(calls).toEqual(["push:嗯", "finish"]);
  });

  it("slowStreamSpeechLive is optional on the sink", () => {
    const sink: Pick<ActorStreamingSink, "slowStreamSpeechLive"> = {};
    expect(sink.slowStreamSpeechLive).toBeUndefined();
  });
});

describe("ActorStreamingSink — slowStreamSpeech contract", () => {
  it("slowStreamSpeech is optional (omitting it compiles)", () => {
    // A sink without slowStreamSpeech must still satisfy the
    // ActorStreamingSink contract — this is the fallback case from
    // spec §10. The test is a compile-time check: if this assignment
    // fails type-checking, the optional marker has been dropped.
    const minimal: ActorStreamingSink = {
      beginHertaStream: () => {},
      streamHertaToken: () => {},
      endHertaStream: () => {},
      flushBlocks: () => {},
    };
    expect(minimal.slowStreamSpeech).toBeUndefined();
  });

  it("slowStreamSpeech, when present, returns a controller with the three required members", () => {
    const ctrl: SlowStreamController = {
      done: Promise.resolve(),
      fastForward: async () => {},
      cancelAndBackspace: async () => {},
    };
    const sinkWithSlow: ActorStreamingSink = {
      beginHertaStream: () => {},
      streamHertaToken: () => {},
      endHertaStream: () => {},
      flushBlocks: () => {},
      slowStreamSpeech: () => ctrl,
    };
    const c = sinkWithSlow.slowStreamSpeech?.("hi");
    expect(c).toBeDefined();
    expect(typeof c?.fastForward).toBe("function");
    expect(typeof c?.cancelAndBackspace).toBe("function");
    expect(c?.done).toBeInstanceOf(Promise);
  });
});
