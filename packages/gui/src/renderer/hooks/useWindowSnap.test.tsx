import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowSnap } from "./useWindowSnap.js";

let snapping: boolean | null = null;

function Host() {
  snapping = useWindowSnap();
  return null;
}

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: w,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: h,
    configurable: true,
  });
}

function resizeTo(w: number, h: number): void {
  setViewport(w, h);
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  vi.useFakeTimers();
  snapping = null;
  setViewport(1440, 900);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useWindowSnap", () => {
  it("is false initially", () => {
    render(<Host />);
    expect(snapping).toBe(false);
  });

  it("veils on a snap-sized jump (maximize) and settles after the beat", () => {
    render(<Host />);
    act(() => resizeTo(1920, 1032));
    expect(snapping).toBe(true);
    act(() => vi.advanceTimersByTime(259));
    expect(snapping).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(snapping).toBe(false);
  });

  it("never triggers on interactive drag-sized deltas", () => {
    render(<Host />);
    // An edge drag: many small per-event deltas that ADD UP past the
    // threshold — the veil must key on per-event jumps, not the total.
    for (let w = 1440; w < 1740; w += 20) {
      act(() => resizeTo(w, 900));
    }
    expect(snapping).toBe(false);
  });

  it("extends the veil across a rapid double-snap", () => {
    render(<Host />);
    act(() => resizeTo(1920, 1032)); // maximize
    act(() => vi.advanceTimersByTime(200));
    act(() => resizeTo(1440, 900)); // restore before the first beat ends
    act(() => vi.advanceTimersByTime(200));
    expect(snapping).toBe(true); // second snap re-armed the timer
    act(() => vi.advanceTimersByTime(60));
    expect(snapping).toBe(false);
  });
});
