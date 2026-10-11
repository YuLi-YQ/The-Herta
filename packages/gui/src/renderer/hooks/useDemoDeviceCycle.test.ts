import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reduced = vi.hoisted(() => ({ value: false }));
vi.mock("./useReducedMotion.js", () => ({
  useReducedMotion: () => reduced.value,
}));

import { useDemoDeviceCycle } from "./useDemoDeviceCycle.js";

describe("useDemoDeviceCycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reduced.value = false;
  });
  afterEach(() => vi.useRealTimers());

  it("starts at idle and advances through the cycle", () => {
    const { result } = renderHook(() => useDemoDeviceCycle(false));
    expect(result.current).toBe("idle");
    act(() => vi.advanceTimersByTime(1600));
    expect(result.current).toBe("delegated");
    act(() => vi.advanceTimersByTime(2600));
    expect(result.current).toBe("waitingApproval");
  });

  it("holds the current state while paused, then resumes", () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: boolean }) => useDemoDeviceCycle(p),
      { initialProps: { p: false } },
    );
    act(() => vi.advanceTimersByTime(1600));
    expect(result.current).toBe("delegated");
    rerender({ p: true });
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe("delegated"); // held while paused
    rerender({ p: false });
    act(() => vi.advanceTimersByTime(2600));
    expect(result.current).toBe("waitingApproval"); // resumed
  });

  it("holds idle and never advances under reduced motion", () => {
    reduced.value = true;
    const { result } = renderHook(() => useDemoDeviceCycle(false));
    expect(result.current).toBe("idle");
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current).toBe("idle");
  });

  it("clears its timer on unmount", () => {
    const spy = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderHook(() => useDemoDeviceCycle(false));
    unmount();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
