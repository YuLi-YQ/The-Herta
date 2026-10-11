import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MIN_PX,
  clampViewerWidth,
  VIEWER_GAP_PX,
  VIEWER_MIN_PX,
  viewerFitsDocked,
} from "./file-viewer-context.js";

/**
 * The docked/overlay decision and the width clamp, exercised the way a
 * sidebar slide exercises them (2026-09-01 flash bug): the shell's resize
 * measurement delivers FRACTIONAL body widths every frame while the clamp
 * binds, and
 * the two functions together must answer with one stable mode — the live
 * bug was `Math.round` handing the panel a half-pixel the conversation
 * didn't have, so the old fit test (evaluated at exact equality) flipped
 * docked↔overlay with the sub-pixel noise, restarting the overlay sheet
 * animation from opacity 0 — the panel visibly flashed on every toggle.
 */
describe("viewer layout math (ADR 0050)", () => {
  it("clamp caps to the space that leaves the conversation its floor", () => {
    expect(clampViewerWidth(804, 1112)).toBe(1112 - 584);
    expect(clampViewerWidth(480, 1388)).toBe(480); // cap not binding
  });

  it("clamp never exceeds the true available space on fractional widths (floor, not round)", () => {
    // The bug's exact shape: at 1158.7 the old round() answered 575, and
    // 1158.7 − 575 − 24 = 559.7 < 560 broke the conversation floor. Below
    // the docked threshold (904) the invariant is viewerFitsDocked's to
    // answer — overlay mode — so only docked-range widths belong here.
    for (const bw of [1158.7, 1158.5, 1158.3, 1159.9, 904.9, 1387.0001]) {
      const w = clampViewerWidth(10_000, bw); // force the cap to bind
      expect(bw - w - VIEWER_GAP_PX).toBeGreaterThanOrEqual(
        CONVERSATION_MIN_PX,
      );
      expect(Number.isInteger(w)).toBe(true);
    }
  });

  it("clamp holds the panel minimum even when nothing fits", () => {
    expect(clampViewerWidth(100, 2000)).toBe(VIEWER_MIN_PX);
    expect(clampViewerWidth(800, 700)).toBe(VIEWER_MIN_PX);
  });

  it("docked mode is stable across a full sidebar slide with the clamp binding", () => {
    // A 1440px window: sidebar expand slides the body's content width from
    // 1388 down to 1112 while a 804px stored width keeps the clamp bound.
    // Every frame's fractional measurement must answer "docked" — one
    // wobble here is one visible flash.
    for (let bw = 1388; bw >= 1112; bw -= 3.7) {
      expect(viewerFitsDocked(bw)).toBe(true);
    }
  });

  it("the overlay threshold itself is unchanged: panel minimum + gap + conversation floor", () => {
    const threshold = VIEWER_MIN_PX + VIEWER_GAP_PX + CONVERSATION_MIN_PX;
    expect(viewerFitsDocked(threshold)).toBe(true);
    expect(viewerFitsDocked(threshold - 0.1)).toBe(false);
    expect(viewerFitsDocked(0)).toBe(false);
  });
});
