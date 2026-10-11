import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScrollEdges } from "./useScrollEdges.js";

/** A fake scroll element: jsdom layout metrics are all 0, so define them. */
function scrollEl(metrics: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", {
    value: metrics.clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: metrics.scrollHeight,
    configurable: true,
  });
  el.scrollTop = metrics.scrollTop;
  return el;
}

describe("useScrollEdges", () => {
  it("reports no edges when the content fits", () => {
    const el = scrollEl({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 });
    const { result } = renderHook(() => useScrollEdges({ current: el }));
    expect(result.current).toEqual({ top: false, bottom: false });
  });

  it("reports bottom only when at the top of overflowing content", () => {
    const el = scrollEl({ scrollTop: 0, clientHeight: 200, scrollHeight: 600 });
    const { result } = renderHook(() => useScrollEdges({ current: el }));
    expect(result.current).toEqual({ top: false, bottom: true });
  });

  it("reports both edges mid-scroll", () => {
    const el = scrollEl({
      scrollTop: 100,
      clientHeight: 200,
      scrollHeight: 600,
    });
    const { result } = renderHook(() => useScrollEdges({ current: el }));
    expect(result.current).toEqual({ top: true, bottom: true });
  });

  it("reports top only when scrolled to the bottom", () => {
    const el = scrollEl({
      scrollTop: 400,
      clientHeight: 200,
      scrollHeight: 600,
    });
    const { result } = renderHook(() => useScrollEdges({ current: el }));
    expect(result.current).toEqual({ top: true, bottom: false });
  });

  it("re-evaluates on scroll events", () => {
    const el = scrollEl({ scrollTop: 0, clientHeight: 200, scrollHeight: 600 });
    const { result } = renderHook(() => useScrollEdges({ current: el }));
    expect(result.current.top).toBe(false);
    act(() => {
      el.scrollTop = 50;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.top).toBe(true);
  });

  it("returns no edges for a null ref", () => {
    const { result } = renderHook(() =>
      useScrollEdges({ current: null as HTMLElement | null }),
    );
    expect(result.current).toEqual({ top: false, bottom: false });
  });
});
