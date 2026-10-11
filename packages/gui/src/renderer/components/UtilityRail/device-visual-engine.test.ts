import { describe, expect, it } from "vitest";
import { STATE_TARGETS } from "./device-scene/lighting.js";
import {
  DEVICE_STATE_VISUALS,
  errorEnvelope,
  initialDeviceVisual,
  stepDeviceVisual,
  successEnvelope,
} from "./device-visual-engine.js";

describe("device-visual-engine", () => {
  it("the 2D lamp is the 3D indicator's: colour, strength relative to idle, breath (ADR 0057 §2.14)", () => {
    const idle = DEVICE_STATE_VISUALS.idle;
    expect(idle.lamp).toBe(1);
    // #86cdf2
    expect(idle.lampColor[0]).toBeCloseTo(0x86 / 255, 5);
    expect(idle.lampColor[1]).toBeCloseTo(0xcd / 255, 5);
    expect(idle.lampColor[2]).toBeCloseTo(0xf2 / 255, 5);
    const working = DEVICE_STATE_VISUALS.delegated;
    expect(working.lamp).toBeCloseTo(
      STATE_TARGETS.delegated.intensity / STATE_TARGETS.idle.intensity,
      5,
    );
    expect(working.breathHz).toBe(STATE_TARGETS.delegated.hz);
    expect(working.breathDepth).toBe(STATE_TARGETS.delegated.depth);
    // The amber approval lamp is genuinely amber.
    const amber = DEVICE_STATE_VISUALS.waitingApproval.lampColor;
    expect(amber[0]).toBeGreaterThan(amber[2]);
  });

  it("initializes at the given state's targets", () => {
    const anim = initialDeviceVisual("waitingApproval");
    const t = DEVICE_STATE_VISUALS.waitingApproval;
    expect(anim.lampColor).toEqual([...t.lampColor]);
    expect(anim.lamp).toBe(t.lamp);
    expect(anim.flashKind).toBe("none");
  });

  it("converges the colour and strength toward a new state's targets", () => {
    const anim = initialDeviceVisual("idle");
    // ~2s of frames — far past the 0.35s ease constant.
    let u = stepDeviceVisual(anim, "waitingApproval", 1 / 60, false);
    for (let i = 0; i < 120; i++) {
      u = stepDeviceVisual(anim, "waitingApproval", 1 / 60, false);
    }
    const t = DEVICE_STATE_VISUALS.waitingApproval;
    expect(u.lampColor[0]).toBeCloseTo(t.lampColor[0], 2);
    expect(u.lampColor[1]).toBeCloseTo(t.lampColor[1], 2);
    expect(u.lampColor[2]).toBeCloseTo(t.lampColor[2], 2);
    // Breath-modulated, within its depth of the target.
    expect(Math.abs(u.lamp - t.lamp)).toBeLessThan(
      t.lamp * t.breathDepth * 1.05,
    );
    // The amber LED is genuinely amber — red channel dominates blue,
    // the exact inversion of the idle blue it started from.
    expect(u.lampColor[0]).toBeGreaterThan(u.lampColor[2]);
  });

  it("breathes: the strength oscillates around the target over a cycle", () => {
    const anim = initialDeviceVisual("idle");
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      samples.push(stepDeviceVisual(anim, "idle", 1 / 60, false).lamp);
    }
    const t = DEVICE_STATE_VISUALS.idle;
    expect(Math.max(...samples)).toBeGreaterThan(t.lamp * 1.02);
    expect(Math.min(...samples)).toBeLessThan(t.lamp * 0.98);
  });

  it("entering succeeded fires the success flash, which decays away and lifts the lamp meanwhile", () => {
    const anim = initialDeviceVisual("delegated");
    const first = stepDeviceVisual(anim, "succeeded", 1 / 60, false);
    expect(anim.flashKind).toBe("success");
    expect(first.flash).toBeGreaterThan(0);
    // Peak inside the rise window…
    let peak = first.flash;
    let lampAtPeak = first.lamp;
    for (let i = 0; i < 30; i++) {
      const u = stepDeviceVisual(anim, "succeeded", 1 / 60, false);
      if (u.flash > peak) {
        peak = u.flash;
        lampAtPeak = u.lamp;
      }
    }
    expect(peak).toBeGreaterThan(0.8);
    expect(lampAtPeak).toBeGreaterThan(
      DEVICE_STATE_VISUALS.succeeded.lamp * 1.3,
    );
    // …and gone after the 1.5s envelope.
    for (let i = 0; i < 90; i++) {
      stepDeviceVisual(anim, "succeeded", 1 / 60, false);
    }
    expect(stepDeviceVisual(anim, "succeeded", 1 / 60, false).flash).toBe(0);
  });

  it("error envelope double-blinks: two humps with a dip between", () => {
    // Sample the pure envelope — hump, dip, hump, settle.
    expect(errorEnvelope(0.1)).toBeCloseTo(1, 5);
    expect(errorEnvelope(0.26)).toBeLessThan(0.2);
    expect(errorEnvelope(0.42)).toBeCloseTo(1, 5);
    expect(errorEnvelope(0.7)).toBeLessThan(0.2);
    expect(errorEnvelope(2)).toBe(0);
    // And the step wires it on the failed edge.
    const anim = initialDeviceVisual("runningCommand");
    stepDeviceVisual(anim, "failed", 1 / 60, false);
    expect(anim.flashKind).toBe("error");
  });

  it("success envelope rises then fully decays", () => {
    expect(successEnvelope(0)).toBe(0);
    expect(successEnvelope(0.3)).toBeCloseTo(1, 5);
    expect(successEnvelope(0.9)).toBeGreaterThan(0);
    expect(successEnvelope(0.9)).toBeLessThan(1);
    expect(successEnvelope(1.6)).toBe(0);
  });

  it("reduced motion pins the breath and skips flashes, but colours still ease", () => {
    const anim = initialDeviceVisual("idle");
    let u = stepDeviceVisual(anim, "succeeded", 1 / 60, true);
    expect(u.flash).toBe(0);
    expect(anim.flashKind).toBe("none");
    for (let i = 0; i < 120; i++) {
      u = stepDeviceVisual(anim, "succeeded", 1 / 60, true);
      expect(u.flash).toBe(0);
    }
    // No oscillation: the strength converges on the target, never
    // breath-modulated. The colour still landed on green.
    const t = DEVICE_STATE_VISUALS.succeeded;
    expect(u.lamp).toBeCloseTo(t.lamp, 2);
    expect(u.lampColor[1]).toBeCloseTo(t.lampColor[1], 2);
  });

  it("leaving a flash state clears the flash", () => {
    const anim = initialDeviceVisual("delegated");
    stepDeviceVisual(anim, "succeeded", 1 / 60, false);
    expect(anim.flashKind).toBe("success");
    const u = stepDeviceVisual(anim, "idle", 1 / 60, false);
    expect(anim.flashKind).toBe("none");
    expect(u.flash).toBe(0);
  });
});
