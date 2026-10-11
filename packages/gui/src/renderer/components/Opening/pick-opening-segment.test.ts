import { describe, expect, it } from "vitest";
import type { SegmentData } from "./ascii-renderer.js";
import { pickOpeningSegment } from "./pick-opening-segment.js";

function fakeLoaders(): Record<string, () => Promise<SegmentData>> {
  const loaders: Record<string, () => Promise<SegmentData>> = {};
  for (let i = 0; i < 8; i += 1) {
    const key = `/openings/seg-${i}.json`;
    loaders[key] = () =>
      Promise.resolve({ type: `seg-${i}` } as unknown as SegmentData);
  }
  return loaders;
}

describe("pickOpeningSegment", () => {
  it("returns the first loader when rng is 0", async () => {
    const loader = pickOpeningSegment(fakeLoaders(), () => 0);
    expect((await loader()).type).toBe("seg-0");
  });

  it("returns the last loader when rng is just under 1", async () => {
    const loader = pickOpeningSegment(fakeLoaders(), () => 0.999);
    expect((await loader()).type).toBe("seg-7");
  });

  it("always returns a loader within range for varied rng", async () => {
    for (const r of [0.1, 0.33, 0.5, 0.7, 0.95]) {
      const loader = pickOpeningSegment(fakeLoaders(), () => r);
      expect(typeof loader).toBe("function");
      await expect(loader()).resolves.toBeDefined();
    }
  });
});
