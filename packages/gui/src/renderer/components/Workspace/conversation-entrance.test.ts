import { describe, expect, it } from "vitest";
import {
  ENTRANCE_DRIFT_PX,
  ENTRANCE_DURATION_MS,
  ENTRANCE_STAGGER_MS,
  planStaggerEntrance,
} from "./conversation-entrance.js";

const VP = { top: 0, bottom: 400 };

describe("planStaggerEntrance", () => {
  it("staggers every row top-to-bottom when all fit the viewport", () => {
    const rows = [
      { top: 0, bottom: 80 },
      { top: 80, bottom: 160 },
      { top: 160, bottom: 240 },
    ];
    const plan = planStaggerEntrance({ rows, viewport: VP, staggerMs: 70 });
    expect(plan.get(0)).toBe(0);
    expect(plan.get(1)).toBe(70);
    expect(plan.get(2)).toBe(140);
  });

  it("animates ONLY the visible bottom suffix; off-screen rows above are omitted", () => {
    // Rows 0 and 1 are scrolled out of view above the viewport; 2,3,4 are in.
    const rows = [
      { top: -200, bottom: -120 }, // fully above
      { top: -120, bottom: -10 }, // fully above
      { top: 10, bottom: 150 }, // visible
      { top: 150, bottom: 290 }, // visible
      { top: 290, bottom: 430 }, // visible (peeks past the bottom)
    ];
    const plan = planStaggerEntrance({ rows, viewport: VP, staggerMs: 70 });
    expect(plan.has(0)).toBe(false);
    expect(plan.has(1)).toBe(false);
    // The topmost VISIBLE row leads the cascade at delay 0.
    expect(plan.get(2)).toBe(0);
    expect(plan.get(3)).toBe(70);
    expect(plan.get(4)).toBe(140);
  });

  it("counts a row peeking in at either edge as visible (any overlap)", () => {
    const rows = [
      { top: -40, bottom: 8 }, // bottom 8px pokes into the top of the viewport
      { top: 396, bottom: 460 }, // top 4px pokes in at the bottom
    ];
    const plan = planStaggerEntrance({ rows, viewport: VP, staggerMs: 70 });
    expect(plan.get(0)).toBe(0);
    expect(plan.get(1)).toBe(70);
  });

  it("returns an empty plan when no row intersects the viewport", () => {
    const rows = [
      { top: -200, bottom: -100 },
      { top: 500, bottom: 600 },
    ];
    const plan = planStaggerEntrance({ rows, viewport: VP, staggerMs: 70 });
    expect(plan.size).toBe(0);
  });

  it("exports the adopted feel constants", () => {
    expect(ENTRANCE_DURATION_MS).toBe(350);
    expect(ENTRANCE_STAGGER_MS).toBe(70);
    expect(ENTRANCE_DRIFT_PX).toBe(12);
  });
});
