import { describe, expect, it } from "vitest";
import { STATE_TARGETS } from "./lighting.js";
import {
  CLOUD_VISIBLE_PHASE,
  COLOR_VISIBLE_DELTA,
  HOUR_VISIBLE_DELTA,
  pictureChanged,
  RING_VISIBLE_DELTA,
  type ShownPicture,
} from "./render-gate.js";

const still = (over: Partial<ShownPicture> = {}): ShownPicture => ({
  ring: 2.4,
  color: [0.2, 0.6, 0.9],
  hour: 12,
  lift: 0,
  cloud: 0,
  ...over,
});

/** Runs the loop's breath (and, with `clouds`, the daytime cloud drift)
 *  for `seconds` at `tickHz` through the gate and returns how many ticks
 *  would have drawn, per second. */
function drawsPerSecond(
  state: keyof typeof STATE_TARGETS,
  seconds: number,
  tickHz = 20,
  clouds = false,
): number {
  const target = STATE_TARGETS[state];
  let shown: ShownPicture | null = null;
  let draws = 0;
  const ticks = seconds * tickHz;
  for (let i = 0; i < ticks; i += 1) {
    const t = i / tickHz;
    const breath = 1 + Math.sin(t * target.hz * Math.PI * 2) * target.depth;
    const next = still({
      ring: target.intensity * breath,
      cloud: clouds ? t : 0,
    });
    if (pictureChanged(shown, next)) {
      draws += 1;
      shown = next;
    }
  }
  return draws / seconds;
}

describe("the render gate (ADR 0057 §2.10)", () => {
  it("nothing drawn yet always draws; the same picture never does", () => {
    expect(pictureChanged(null, still())).toBe(true);
    expect(pictureChanged(still(), still())).toBe(false);
  });

  it("the idle breath draws about a third of the 20 Hz ticks, with the same look", () => {
    const perSecond = drawsPerSecond("idle", 30);
    expect(perSecond).toBeGreaterThan(5);
    expect(perSecond).toBeLessThan(9);
  });

  it("passing clouds add about four draws a second to the idle breath (§2.11)", () => {
    const withClouds = drawsPerSecond("idle", 30, 20, true);
    expect(withClouds).toBeGreaterThan(drawsPerSecond("idle", 30));
    expect(withClouds).toBeLessThan(12);
    // A quarter second of drift is the step; less is the same picture.
    expect(
      pictureChanged(still(), still({ cloud: CLOUD_VISIBLE_PHASE / 2 })),
    ).toBe(false);
    expect(pictureChanged(still(), still({ cloud: CLOUD_VISIBLE_PHASE }))).toBe(
      true,
    );
  });

  it("a working state's breath is fast enough to draw most ticks (only the crests are skipped)", () => {
    expect(drawsPerSecond("delegated", 30)).toBeGreaterThan(15);
    expect(drawsPerSecond("writing", 30)).toBeGreaterThan(15);
  });

  it("the shallow end-state breaths draw a few times a second", () => {
    expect(drawsPerSecond("succeeded", 30)).toBeLessThan(7);
    expect(drawsPerSecond("failed", 30)).toBeLessThan(5);
    expect(drawsPerSecond("failed", 30)).toBeGreaterThan(1);
  });

  it("the thresholds: lamp, colour channel, clock (shortest way round), any lift", () => {
    const s = still();
    expect(
      pictureChanged(s, still({ ring: s.ring * (1 + RING_VISIBLE_DELTA / 2) })),
    ).toBe(false);
    expect(
      pictureChanged(s, still({ ring: s.ring * (1 + RING_VISIBLE_DELTA) })),
    ).toBe(true);
    expect(
      pictureChanged(
        s,
        still({ color: [0.2, 0.6 + COLOR_VISIBLE_DELTA / 2, 0.9] }),
      ),
    ).toBe(false);
    // A hair over each threshold: the sums are not exact in binary.
    expect(
      pictureChanged(
        s,
        still({ color: [0.2, 0.6 + COLOR_VISIBLE_DELTA * 1.01, 0.9] }),
      ),
    ).toBe(true);
    expect(
      pictureChanged(s, still({ hour: 12 + HOUR_VISIBLE_DELTA / 2 })),
    ).toBe(false);
    expect(
      pictureChanged(s, still({ hour: 12 + HOUR_VISIBLE_DELTA * 1.01 })),
    ).toBe(true);
    // 23.995 → 0.001 is a 0.006 h step, not a 23.99 h one.
    expect(
      pictureChanged(still({ hour: 23.995 }), still({ hour: 0.001 })),
    ).toBe(false);
    expect(pictureChanged(s, still({ lift: 1e-4 }))).toBe(true);
  });
});
