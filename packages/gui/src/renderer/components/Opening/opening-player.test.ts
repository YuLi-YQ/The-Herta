import { describe, expect, it, vi } from "vitest";
import type { SegmentData } from "./ascii-renderer.js";
import { createOpeningPlayer, type OpeningContext } from "./opening-player.js";

function stubSegment(): SegmentData {
  // One dark cell, 2 frames -> 1/12 s of playback.
  const bytes = new Uint8Array([10, 10]);
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

/** A surface that counts every size assignment (each one wipes a canvas). */
function countingSurface() {
  let width = 300;
  let height = 150;
  const sets = { count: 0 };
  const surface = {
    get width() {
      return width;
    },
    set width(v: number) {
      sets.count += 1;
      width = v;
    },
    get height() {
      return height;
    },
    set height(v: number) {
      sets.count += 1;
      height = v;
    },
  };
  return { surface, sets };
}

function stubContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    font: "",
    fillStyle: "",
    globalAlpha: 1,
    textAlign: "",
    textBaseline: "",
  };
}

const EVENTS = { onDissolve: () => undefined, onInstant: () => undefined };

describe("the opening player's canvas size (owner 2026-09-25: blue frames)", () => {
  it("leaves an unchanged size alone — setting it would wipe the canvas", () => {
    const { surface, sets } = countingSurface();
    const ctx = stubContext();
    const player = createOpeningPlayer(
      surface,
      ctx as unknown as OpeningContext,
      stubSegment(),
      false,
      EVENTS,
      0,
    );
    player.resize(800, 600, 1);
    expect(sets.count).toBe(2);
    player.resize(800, 600, 1);
    expect(sets.count).toBe(2);
  });

  it("repaints a wiped canvas in the same call: the opaque cover before the first frame", () => {
    const { surface } = countingSurface();
    const ctx = stubContext();
    const player = createOpeningPlayer(
      surface,
      ctx as unknown as OpeningContext,
      stubSegment(),
      false,
      EVENTS,
      0,
    );
    player.resize(800, 600, 1);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(ctx.fillStyle).toBe("rgba(255, 255, 255, 1)");
  });

  it("repaints a wiped canvas in the same call: the last frame, mid-animation", () => {
    const { surface } = countingSurface();
    const ctx = stubContext();
    const player = createOpeningPlayer(
      surface,
      ctx as unknown as OpeningContext,
      stubSegment(),
      false,
      EVENTS,
      0,
    );
    player.resize(800, 600, 1);
    player.frame(10);
    player.frame(50);
    ctx.fillRect.mockClear();
    ctx.fillText.mockClear();
    // The window is resized (a restored size, a maximize) mid-animation.
    player.resize(1024, 700, 1);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1024, 700);
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("does not repaint after the instant finish wiped the canvas for good", () => {
    const { surface } = countingSurface();
    const ctx = stubContext();
    const player = createOpeningPlayer(
      surface,
      ctx as unknown as OpeningContext,
      stubSegment(),
      false,
      EVENTS,
      0,
    );
    player.resize(800, 600, 1);
    player.frame(10);
    // Frozen for a minute (a hidden window): the instant finish.
    expect(player.frame(60_000)).toBe(false);
    ctx.fillRect.mockClear();
    ctx.fillText.mockClear();
    player.resize(1024, 700, 1);
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});
