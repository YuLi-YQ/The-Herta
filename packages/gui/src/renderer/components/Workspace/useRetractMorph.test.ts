import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commonPrefixLen,
  RETRACT_HOLD_MS,
  RETRACT_WAIT_MAX_MS,
  shrinkDelayMs,
  UNKNOWN_MAX_DELAY_MS,
  unknownDelayMs,
  useRetractMorph,
} from "./useRetractMorph.js";
import { MAX_REVEAL_PER_FRAME } from "./useRevealedText.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Wall-clock ms (from the retract rising edge) at which the erase has deleted
 *  exactly `n` chars: the hold beat + the cumulative ramped per-char delays,
 *  plus a sub-tick margin so the assertion lands just past the n-th deletion. */
function eraseMs(n: number): number {
  let ms = RETRACT_HOLD_MS;
  for (let k = 0; k < n; k += 1) ms += shrinkDelayMs(k);
  return ms + 5;
}

describe("commonPrefixLen", () => {
  it("returns the code-point length of the longest common prefix", () => {
    expect(commonPrefixLen("ABCDEFG", "ABCJ")).toBe(3);
    expect(commonPrefixLen("", "abc")).toBe(0);
    expect(commonPrefixLen("abc", "")).toBe(0);
    expect(commonPrefixLen("同前缀不同尾", "同前缀另一个")).toBe(3);
    expect(commonPrefixLen("identical", "identical")).toBe(9);
  });

  it("counts code points, not UTF-16 units (surrogate-safe)", () => {
    // "𝄞" is one code point but two UTF-16 units.
    expect(commonPrefixLen("𝄞A", "𝄞B")).toBe(1);
    expect(commonPrefixLen("𝄞", "𝄟")).toBe(0);
  });
});

interface MorphProps {
  retracting: boolean;
  vetoed: string | null;
  retryText: string | null;
  revealed: string | null;
  reduced: boolean;
  keepLen?: number | null;
}

function renderMorph(initial: MorphProps) {
  return renderHook((p: MorphProps) => useRetractMorph(p), {
    initialProps: initial,
  });
}

describe("useRetractMorph", () => {
  it("returns null while not retracting", () => {
    const { result } = renderMorph({
      retracting: false,
      vetoed: "abc",
      retryText: null,
      revealed: "abc",
      reduced: false,
    });
    expect(result.current).toBeNull();
  });

  it("shrinks only to the divergence point, then types the retry forward", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFG",
      retryText: null,
      revealed: "ABCDEFG",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    // Retract begins; the retry's tokens arrive immediately, sharing "ABC".
    rerender({ ...props, retracting: true, retryText: "ABCJ" });
    // Hold beat, then the ramped erase deletes G,F,E,D (pos 7 → 3 = prefix).
    act(() => {
      vi.advanceTimersByTime(eraseMs(4));
    });
    expect(result.current).toBe("ABC");
    // Fill: types the retry tail forward from the divergence point.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("ABCJ");
    // Later deltas keep filling without re-shrinking.
    rerender({ ...props, retracting: true, retryText: "ABCJKL" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("ABCJKL");
  });

  it("halts the backward erase at the server keepLen even before any retry delta", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFG",
      retryText: null,
      revealed: "ABCDEFG",
      reduced: false,
      keepLen: null,
    };
    const { result, rerender } = renderMorph(props);
    // Retract; the server reports the divergence (3) up front, retry not yet streaming.
    rerender({ ...props, retracting: true, keepLen: 3 });
    act(() => {
      vi.advanceTimersByTime(eraseMs(10)); // long enough to erase everything
    });
    expect(result.current).toBe("ABC"); // stopped at keepLen; did NOT wipe to ""
  });

  it("keepLen 0 erases to empty (wholly-divergent retry)", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDE",
      retryText: null,
      revealed: "ABCDE",
      reduced: false,
      keepLen: null,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true, keepLen: 0, retryText: "XYZ" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(5) + 300);
    });
    expect(result.current).toBe("XYZ");
  });

  it("the server keepLen wins over a smaller transient live diff (Math.max)", () => {
    // The floor's whole point: the server says the divergence is at 3, but the
    // paced replay has only streamed "AB" so far (live commonPrefixLen = 2). The
    // erase must stop at the authoritative 3, NOT over-erase to 2 — i.e. the
    // shrink floor is max(serverFloor, liveDiff), not the live diff alone.
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFG",
      retryText: null,
      revealed: "ABCDEFG",
      reduced: false,
      keepLen: null,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true, keepLen: 3, retryText: "AB" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(10));
    });
    expect(result.current).toBe("ABC"); // halted at keepLen 3, not the live diff 2
  });

  it("DECELERATES with depth while the divergence is unknown, so the tail survives", () => {
    // The whole point of the hook. Between 2026-06-14 and the two-stage
    // rethink the erase ran straight to empty at full speed when no retry was
    // in yet, which was fine when the retry followed within a few hundred ms.
    // The rethink (2026-07-18) put a full model call in between, so the floor
    // lands SECONDS later — and at 40 chars/second the erase hit empty first
    // on any ordinary line, degrading every veto into wipe-then-retype.
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFGHIJ",
      retryText: null,
      revealed: "ABCDEFGHIJ",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true }); // retract; retry still silent
    // Well past the un-decelerated time to empty: it is still going, and
    // still has a tail left to preserve.
    act(() => {
      vi.advanceTimersByTime(eraseMs(10) + 500);
    });
    const mid = result.current ?? "";
    expect(mid.length).toBeGreaterThan(0); // NOT wiped
    expect(mid.length).toBeLessThan(10); // but visibly moving, not frozen
    // The respeak finally starts and shares "ABC": the erase returns to full
    // speed and converges on a divergence that is still on screen.
    rerender({ ...props, retracting: true, retryText: "ABCJ" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(10) + 400);
    });
    expect(result.current).toBe("ABCJ");
  });

  it("never erases past a prefix the retry turns out to share", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFGH",
      retryText: null,
      revealed: "ABCDEFGH",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true, keepLen: 6 });
    act(() => {
      vi.advanceTimersByTime(eraseMs(2) + 300);
    });
    expect(result.current).toBe("ABCDEF"); // stopped at the floor
  });

  it("finishes at full speed after the deadline, so a retry that never comes cannot strand it", () => {
    // Empty-recovery ladder, failed respeak, interrupt: no retry, no floor,
    // ever. The deadline drops the deceleration rather than crawling until
    // the record block snaps over it.
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDE",
      retryText: null,
      revealed: "ABCDE",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true });
    act(() => {
      vi.advanceTimersByTime(RETRACT_WAIT_MAX_MS + eraseMs(5) + 500);
    });
    expect(result.current).toBe("");
  });

  it("unknownDelayMs: no slowdown at the start, hyperbolic with depth, capped", () => {
    // 1× while nothing has been erased yet — the retract still snaps into
    // motion — then growing as the prefix is given up, and clamped so the
    // tail never reads as stalled.
    expect(unknownDelayMs({ base: 25, shown: 100, pos: 100 })).toBe(25);
    expect(unknownDelayMs({ base: 25, shown: 100, pos: 50 })).toBe(50);
    expect(unknownDelayMs({ base: 25, shown: 100, pos: 10 })).toBe(250);
    expect(unknownDelayMs({ base: 25, shown: 100, pos: 1 })).toBe(
      UNKNOWN_MAX_DELAY_MS,
    );
    // pos 0 must not divide by zero.
    expect(unknownDelayMs({ base: 25, shown: 100, pos: 0 })).toBe(
      UNKNOWN_MAX_DELAY_MS,
    );
  });

  it("a keepLen arriving with no retry text still releases the wait", () => {
    // The floor is authoritative and can land before any delta — it is a
    // sufficient signal on its own.
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFG",
      retryText: null,
      revealed: "ABCDEFG",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true, keepLen: 4 });
    act(() => {
      vi.advanceTimersByTime(eraseMs(3) + 200);
    });
    expect(result.current).toBe("ABCD");
  });

  it("a wholly-divergent retry: erases to empty after the beat, then fills the replacement", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "你好世界",
      retryText: null,
      revealed: "你好世界",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    // Retry shares nothing (matched 0): after the beat the erase runs all the
    // way to empty, then the fill types the replacement.
    rerender({ ...props, retracting: true, retryText: "另起炉灶" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(4) + 400);
    });
    expect(result.current).toBe("另起炉灶");
  });

  it("re-types overshoot: a growing retry confirms a prefix below where the shrink passed", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDE",
      retryText: null,
      revealed: "ABCDE",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    // The retry first looks like it diverges at index 2 ("AB" only); the
    // shrink heads down toward 2, passing the eventual divergence (3).
    rerender({ ...props, retracting: true, retryText: "AB" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(3)); // beat + ramped erase: pos 5 → 2 ("AB")
    });
    expect(result.current).toBe("AB");
    // More retry now confirms "ABC" shares 3 — below the shrink's current 2.
    rerender({ ...props, retracting: true, retryText: "ABCXY" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe("ABCXY"); // fill re-typed the recovered "C", no jump
  });

  it("seeds the shrink from the revealed prefix, not the full candidate", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDEFG",
      retryText: null,
      revealed: "ABCD", // reveal was still catching up when the veto landed
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    // Retry shares "AB" so the shrink runs; it must seed from the revealed
    // prefix (4), not the full candidate (7) — i.e. never paint E/F/G.
    rerender({ ...props, retracting: true, retryText: "ABX" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(1)); // beat + first (slow) deletion: 4 → 3
    });
    expect(result.current).toBe("ABC"); // shrank from ABCD; never showed E/F/G
  });

  it("reduced motion holds the prefix until the retry, then swaps to it (no animation)", () => {
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABC",
      retryText: null,
      revealed: "ABC",
      reduced: true,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true });
    expect(result.current).toBe("ABC"); // held, not blanked
    rerender({ ...props, retracting: true, retryText: "AB新" });
    expect(result.current).toBe("AB新");
  });

  it("cleans up the fill interval too (retract ends after the handoff)", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCDE",
      retryText: null,
      revealed: "ABCDE",
      reduced: false,
    };
    const { result, rerender, unmount } = renderMorph(props);
    // Retry shares "ABC": shrink 2 ticks (pos 5 → 3), then hand off to fill.
    rerender({ ...props, retracting: true, retryText: "ABCXY" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(2));
    });
    expect(result.current).toBe("ABC");
    act(() => {
      vi.advanceTimersByTime(100); // fill is running now
    });
    expect(result.current).toBe("ABCXY");
    // Ending the retract must clear the REASSIGNED fill interval.
    rerender({ ...props, retracting: false });
    expect(result.current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBeNull();
    unmount(); // and unmount mid-everything must not throw / warn
  });

  it("a second retract (later turn) samples the new vetoed text", () => {
    vi.useFakeTimers();
    const first: MorphProps = {
      retracting: false,
      vetoed: "第一次候选",
      retryText: null,
      revealed: "第一次候选",
      reduced: false,
    };
    const { result, rerender } = renderMorph(first);
    // Retry shares "第一次" (3) so the shrink runs against the first candidate.
    rerender({ ...first, retracting: true, retryText: "第一次改写" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(2));
    });
    expect(result.current).toBe("第一次"); // morphing the FIRST candidate (5 → 3)
    // Retract ends (e.g. turn finished); a fresh candidate streams, then a
    // second veto lands. Its retry shares "第二次不同候" (6).
    const second: MorphProps = {
      retracting: false,
      vetoed: "第二次不同候选",
      retryText: null,
      revealed: "第二次不同候选",
      reduced: false,
    };
    rerender(second);
    rerender({ ...second, retracting: true, retryText: "第二次不同候改" });
    act(() => {
      vi.advanceTimersByTime(eraseMs(1));
    });
    expect(result.current).toBe("第二次不同候"); // morphing the SECOND candidate (7 → 6)
  });

  it("clears to null when the retract ends (cleanup cancels timers)", () => {
    vi.useFakeTimers();
    const props: MorphProps = {
      retracting: false,
      vetoed: "ABCD",
      retryText: null,
      revealed: "ABCD",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    rerender({ ...props, retracting: true });
    act(() => {
      vi.advanceTimersByTime(2 * 25 + 5);
    });
    rerender({ ...props, retracting: false });
    expect(result.current).toBeNull();
    // No stray timer keeps mutating state after the retract ended.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBeNull();
  });

  it("caps the fill phase at MAX_REVEAL_PER_FRAME per frame on a big retry chunk", () => {
    vi.useFakeTimers();
    const big = `AB${"x".repeat(100)}`;
    const props: MorphProps = {
      retracting: false,
      vetoed: "AB",
      retryText: null,
      revealed: "AB",
      reduced: false,
    };
    const { result, rerender } = renderMorph(props);
    // Retry arrives as one big chunk sharing the "AB" prefix.
    rerender({ ...props, retracting: true, retryText: big });
    act(() => {
      vi.advanceTimersByTime(RETRACT_HOLD_MS + shrinkDelayMs(0) + 5); // beat + first step (no delete) hands off to fill
    });
    let prev = (result.current ?? "").length;
    for (let i = 0; i < 8; i++) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const len = (result.current ?? "").length;
      expect(len - prev).toBeLessThanOrEqual(MAX_REVEAL_PER_FRAME);
      prev = len;
    }
    expect((result.current ?? "").length).toBeGreaterThan(4); // fill is actually advancing, not stalled
  });

  it("keepLen greater than the displayed prefix erases nothing and fills forward", () => {
    vi.useFakeTimers();
    // Vetoed candidate fully generated, but only the first 4 code points were
    // revealed when the veto landed (live-feed reveal lagged generation).
    const vetoed = "我看了下这个实现，逻辑没问题";
    const revealed = "我看了下"; // 4 cp displayed at veto time
    const retry = "我看了下这个实现，测试也跑通了"; // shares a 9-cp prefix with vetoed
    const keepLen = 9; // server floor, GREATER than displayed (4)

    const { result, rerender } = renderMorph({
      retracting: false,
      vetoed,
      retryText: null,
      revealed,
      keepLen: null,
      reduced: false,
    });

    // Rising edge: start retracting with the server floor + retry present.
    rerender({
      retracting: true,
      vetoed,
      retryText: retry,
      revealed,
      keepLen,
      reduced: false,
    });

    act(() => {
      vi.advanceTimersByTime(RETRACT_HOLD_MS + 200);
    });

    // No over-erase: the displayed text never drops below the 4-cp revealed prefix.
    const shown = result.current ?? "";
    expect(shown.startsWith("我看了下")).toBe(true);

    // Converges to the retry (fill forward), never reveals the vetoed tail.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(retry);
    vi.useRealTimers();
  });
});
