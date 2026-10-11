import { describe, expect, it } from "vitest";
import { advanceLift, createLiftPose, MAX_LIFT_PX } from "./lift.js";

function settle(
  target: number,
  held: boolean,
  maxSteps = 600,
): { pose: ReturnType<typeof createLiftPose>; steps: number; peak: number } {
  const pose = createLiftPose();
  pose.targetLiftPx = target;
  let steps = 0;
  let peak = 0;
  while (advanceLift(pose, 1 / 60, held) && steps < maxSteps) {
    steps += 1;
    peak = Math.max(peak, pose.liftPx);
  }
  return { pose, steps, peak };
}

describe("device-scene lift spring (ADR 0057 §2)", () => {
  it("reaches the target and reports rest", () => {
    const { pose, steps } = settle(MAX_LIFT_PX, true);
    expect(pose.liftPx).toBe(MAX_LIFT_PX);
    expect(pose.velocityPx).toBe(0);
    expect(steps).toBeGreaterThan(3);
    expect(steps).toBeLessThan(120);
  });

  it("never overshoots (critically damped) and never leaves 0..MAX", () => {
    const { peak } = settle(MAX_LIFT_PX, false);
    expect(peak).toBeLessThanOrEqual(MAX_LIFT_PX);
    const pose = createLiftPose();
    pose.liftPx = MAX_LIFT_PX;
    pose.targetLiftPx = 0;
    let min = MAX_LIFT_PX;
    while (advanceLift(pose, 1 / 60, false)) min = Math.min(min, pose.liftPx);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(pose.liftPx).toBe(0);
  });

  it("clamps a target above the ceiling to the ceiling", () => {
    const pose = createLiftPose();
    pose.targetLiftPx = 40;
    for (let i = 0; i < 300; i += 1) advanceLift(pose, 1 / 60, true);
    expect(pose.liftPx).toBe(MAX_LIFT_PX);
  });

  it("is stable across frame rates — 30 fps and 120 fps settle to the same place", () => {
    const at = (dt: number): number => {
      const pose = createLiftPose();
      pose.targetLiftPx = 7;
      for (let t = 0; t < 2; t += dt) advanceLift(pose, dt, false);
      return pose.liftPx;
    };
    expect(at(1 / 30)).toBe(7);
    expect(at(1 / 120)).toBe(7);
  });

  it("a resting pose at its target is not moving", () => {
    const pose = createLiftPose();
    expect(advanceLift(pose, 1 / 60, false)).toBe(false);
  });
});
