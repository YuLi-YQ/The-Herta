import { describe, expect, it } from "vitest";
import {
  computeDragResult,
  DEVICE_SILHOUETTE,
  pointOverDevice,
} from "./dragTracker.js";

describe("pointOverDevice (owner 2026-09-07: the drag area was larger than the device)", () => {
  it("the silhouette is the centred middle of the preview box, about half its width and two thirds its height", () => {
    const w = DEVICE_SILHOUETTE.right - DEVICE_SILHOUETTE.left;
    const h = DEVICE_SILHOUETTE.bottom - DEVICE_SILHOUETTE.top;
    expect(w).toBeGreaterThan(0.5);
    expect(w).toBeLessThan(0.52);
    expect(h).toBeGreaterThan(0.66);
    expect(h).toBeLessThan(0.68);
    expect((DEVICE_SILHOUETTE.left + DEVICE_SILHOUETTE.right) / 2).toBeCloseTo(
      0.5,
      2,
    );
    expect((DEVICE_SILHOUETTE.top + DEVICE_SILHOUETTE.bottom) / 2).toBeCloseTo(
      0.5,
      2,
    );
  });

  it("the centre and the device's own edges are over it; the box's corners and margins are not", () => {
    expect(pointOverDevice(0.5, 0.5)).toBe(true);
    expect(pointOverDevice(DEVICE_SILHOUETTE.left, DEVICE_SILHOUETTE.top)).toBe(
      true,
    );
    expect(pointOverDevice(0.02, 0.02)).toBe(false);
    expect(pointOverDevice(0.98, 0.98)).toBe(false);
    expect(pointOverDevice(0.5, 0.05)).toBe(false); // above the device
    expect(pointOverDevice(0.5, 0.95)).toBe(false); // the floor under it
    expect(pointOverDevice(0.1, 0.5)).toBe(false); // the wall beside it
    expect(pointOverDevice(0.9, 0.5)).toBe(false);
  });
});

describe("computeDragResult", () => {
  const base = {
    dragDeltaY: -20,
    chance: 0.1, // below liftProbability
    threshold: 8,
    liftProbability: 0.3,
    maxLiftPx: 12,
    reducedMotion: false,
  };

  it("returns no lift when drag is downward (positive dy)", () => {
    const out = computeDragResult({ ...base, dragDeltaY: 20 });
    expect(out.transform).toBeNull();
    expect(out.shadowStyle).toBeUndefined();
  });

  it("returns no lift when drag delta is below threshold", () => {
    const out = computeDragResult({ ...base, dragDeltaY: -5 });
    expect(out.transform).toBeNull();
  });

  it("returns no lift when chance exceeds liftProbability", () => {
    const out = computeDragResult({ ...base, chance: 0.9 });
    expect(out.transform).toBeNull();
  });

  it("returns a lift transform when chance + threshold + direction all pass", () => {
    const out = computeDragResult(base);
    expect(out.transform).not.toBeNull();
    expect(out.transform).toMatch(/translateY/);
    expect(out.shadowStyle).toBeDefined();
  });

  it("caps the lift magnitude at maxLiftPx", () => {
    const out = computeDragResult({ ...base, dragDeltaY: -100, maxLiftPx: 12 });
    expect(out.transform).toMatch(/translateY\(-12px\)/);
  });

  it("returns no lift when reducedMotion is true", () => {
    const out = computeDragResult({ ...base, reducedMotion: true });
    expect(out.transform).toBeNull();
  });

  it("reports the lift in px beside the transform — 0 whenever there is no lift (ADR 0057)", () => {
    // base drags 20 px; the 12 px ceiling wins.
    expect(computeDragResult(base).liftPx).toBe(12);
    expect(computeDragResult({ ...base, dragDeltaY: -10 }).liftPx).toBe(10);
    expect(computeDragResult({ ...base, dragDeltaY: 20 }).liftPx).toBe(0);
    expect(computeDragResult({ ...base, chance: 0.9 }).liftPx).toBe(0);
    expect(computeDragResult({ ...base, reducedMotion: true }).liftPx).toBe(0);
  });

  it("shadow style scales down and dims when device is lifted", () => {
    const out = computeDragResult(base);
    // Shadow should be slightly smaller + slightly less opaque to
    // sell the height illusion.
    expect(out.shadowStyle?.transform).toMatch(/scale/);
    expect(out.shadowStyle?.opacity).toBeDefined();
    expect(Number(out.shadowStyle?.opacity ?? 1)).toBeLessThan(1);
  });
});
