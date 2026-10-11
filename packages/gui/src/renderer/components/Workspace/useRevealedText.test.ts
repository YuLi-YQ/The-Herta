import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EN_MAX_REVEAL_PER_FRAME,
  MAX_REVEAL_PER_FRAME,
  useRevealedText,
} from "./useRevealedText.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useRevealedText", () => {
  it("returns null for a null target", () => {
    const { result } = renderHook(() => useRevealedText(null, false));
    expect(result.current).toBeNull();
  });

  it("reveals the full target instantly under reduced motion", () => {
    const { result } = renderHook(() => useRevealedText("黑塔女士", true));
    expect(result.current).toBe("黑塔女士");
  });

  it("reveals the whole target once frames run", () => {
    // Synchronous frames drain the buffer to completion within the effect.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const { result } = renderHook(() => useRevealedText("hello, world", false));
    expect(result.current).toBe("hello, world");
  });

  it("never reveals more than the target", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const { result } = renderHook(() => useRevealedText("hi", false));
    expect(result.current?.length).toBeLessThanOrEqual(2);
  });
});

function mockAsyncRaf(): void {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(
    (cb) => setTimeout(() => cb(0), 16) as unknown as number,
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  });
}

describe("useRevealedText burst cap", () => {
  it("reveals a large burst at most MAX_REVEAL_PER_FRAME chars per frame", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const big = "x".repeat(200);
    const { result } = renderHook((p: string) => useRevealedText(p, false), {
      initialProps: big,
    });
    let prev = (result.current ?? "").length;
    for (let i = 0; i < 10; i++) {
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const len = (result.current ?? "").length;
      expect(len - prev).toBeLessThanOrEqual(MAX_REVEAL_PER_FRAME);
      prev = len;
    }
  });

  it("still uses gap/4 pacing for small gaps (cap not binding)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { result, rerender } = renderHook(
      (p: string) => useRevealedText(p, false),
      { initialProps: "" },
    );
    rerender("abc"); // gap 3 → ceil(3/4)=1 per frame
    act(() => {
      vi.advanceTimersByTime(16 * 4 + 8); // 3 reveal frames at 16ms + margin for the final catch-up tick
    });
    expect(result.current).toBe("abc");
  });

  it("exports the cap constant", () => {
    expect(MAX_REVEAL_PER_FRAME).toBe(3);
  });
});

describe("useRevealedText — EN word-stream rule", () => {
  it("reveals a server-paced word delta promptly (whole word in one frame, not letter-by-letter)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { result } = renderHook(
      (p: string) => useRevealedText(p, false, "en"),
      { initialProps: "parser" }, // 6 cp < cap → pops in one frame
    );
    act(() => vi.advanceTimersByTime(16));
    expect(result.current).toBe("parser");
  });

  it("reveals the final word even with NO trailing whitespace (never stranded)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { result, rerender } = renderHook(
      (p: string) => useRevealedText(p, false, "en"),
      { initialProps: "Hello " },
    );
    act(() => vi.advanceTimersByTime(16));
    expect(result.current).toBe("Hello ");
    rerender("Hello world"); // final unterminated word
    act(() => vi.advanceTimersByTime(16));
    expect(result.current).toBe("Hello world");
  });

  it("reveals a one-token reply ('Done.') immediately — the animation is not lost", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { result } = renderHook(
      (p: string) => useRevealedText(p, false, "en"),
      { initialProps: "Done." },
    );
    act(() => vi.advanceTimersByTime(16));
    expect(result.current).toBe("Done.");
  });

  it("bounds a no-whitespace blob to the EN per-frame cap, and still terminates (no spin)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const blob = "x".repeat(200);
    const { result } = renderHook(
      (p: string) => useRevealedText(p, false, "en"),
      { initialProps: blob },
    );
    act(() => vi.advanceTimersByTime(16));
    const first = (result.current ?? "").length;
    expect(first).toBeLessThanOrEqual(EN_MAX_REVEAL_PER_FRAME);
    expect(first).toBeGreaterThan(MAX_REVEAL_PER_FRAME); // faster than the zh cap
    // Fully revealed within a few frames (the rAF loop terminates).
    act(() => vi.advanceTimersByTime(16 * 10));
    expect(result.current).toBe(blob);
  });

  it("zh (no lang arg) is unchanged — still the ≤ MAX_REVEAL_PER_FRAME letter fill", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const big = "x".repeat(200);
    const { result } = renderHook((p: string) => useRevealedText(p, false), {
      initialProps: big,
    });
    let prev = (result.current ?? "").length;
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(16));
      const len = (result.current ?? "").length;
      expect(len - prev).toBeLessThanOrEqual(MAX_REVEAL_PER_FRAME);
      prev = len;
    }
  });

  it("exports the EN cap constant", () => {
    expect(EN_MAX_REVEAL_PER_FRAME).toBe(48);
  });
});
