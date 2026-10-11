import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SegmentData } from "./ascii-renderer.js";
import { OpeningAscii } from "./OpeningAscii.js";

function stubSegment(): SegmentData {
  const bytes = new Uint8Array([10, 200]);
  return {
    type: "adaptive-ascii-video-segment-v1",
    width: 10,
    height: 10,
    fps: 24,
    frameCount: 2,
    activeCount: 1,
    cells: [[5, 5, 6]],
    framesBase64: btoa(String.fromCharCode(...bytes)),
  };
}

describe("OpeningAscii", () => {
  afterEach(() => vi.useRealTimers());

  it("renders the overlay then calls onDone once after play + fade-out", async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(
      <OpeningAscii
        onDone={onDone}
        loadSegment={() => Promise.resolve(stubSegment())}
      />,
    );
    expect(screen.getByTestId("opening-ascii")).toBeInTheDocument();

    // Flush the segment load promise, then let the canvas timer-fallback
    // (~84ms) and the frosted-glass clear timer (700ms) elapse.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("calls onDone if the segment fails to load", async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(
      <OpeningAscii
        onDone={onDone}
        loadSegment={() => Promise.reject(new Error("load failed"))}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
