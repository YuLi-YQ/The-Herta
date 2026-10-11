import { describe, expect, it } from "vitest";
import {
  initialEnvelope,
  KICK_PER_CHAR,
  PUNCTUATION_CUT,
  RAW_CLAMP,
  REF_FRAME_MS,
  stepEnvelope,
} from "./wave-engine.js";

describe("stepEnvelope", () => {
  it("kicks raise raw (clamped) and the envelope attacks faster than it releases", () => {
    const s = initialEnvelope();
    stepEnvelope(s, REF_FRAME_MS, { count: 1, punctuation: null });
    expect(s.raw).toBeGreaterThan(0);
    expect(s.raw).toBeLessThanOrEqual(RAW_CLAMP);
    // Sustained kicks: env rises.
    for (let i = 0; i < 30; i++) {
      stepEnvelope(s, REF_FRAME_MS, { count: 1, punctuation: null });
    }
    const peak = s.env;
    expect(peak).toBeGreaterThan(0.5);
    // Silence for the same number of frames: env falls SLOWER than it rose
    // (release 0.025 vs attack 0.12) — after 30 quiet frames it retains a
    // meaningful fraction of the peak.
    for (let i = 0; i < 30; i++) {
      stepEnvelope(s, REF_FRAME_MS, { count: 0, punctuation: null });
    }
    expect(s.env).toBeGreaterThan(peak * 0.5);
    expect(s.env).toBeLessThan(peak);
  });

  it("punctuation cuts raw sharply", () => {
    const s = initialEnvelope();
    for (let i = 0; i < 10; i++) {
      stepEnvelope(s, REF_FRAME_MS, { count: 2, punctuation: null });
    }
    const before = s.raw;
    stepEnvelope(s, REF_FRAME_MS, { count: 0, punctuation: "hard" });
    expect(s.raw).toBeLessThan(before * PUNCTUATION_CUT + 0.01);
  });

  it("slow envelope lags the main envelope", () => {
    const s = initialEnvelope();
    for (let i = 0; i < 20; i++) {
      stepEnvelope(s, REF_FRAME_MS, { count: 1, punctuation: null });
    }
    expect(s.slow).toBeGreaterThan(0);
    expect(s.slow).toBeLessThan(s.env);
  });

  it("is frame-rate independent: two 8.33ms steps ≈ one 16.67ms step", () => {
    const a = initialEnvelope();
    const b = initialEnvelope();
    for (let i = 0; i < 12; i++) {
      stepEnvelope(a, REF_FRAME_MS, { count: 1, punctuation: null });
      stepEnvelope(b, REF_FRAME_MS / 2, { count: 1, punctuation: null });
      stepEnvelope(b, REF_FRAME_MS / 2, { count: 0, punctuation: null });
    }
    expect(b.env).toBeGreaterThan(a.env * 0.85);
    expect(b.env).toBeLessThan(a.env * 1.15);
  });

  it("kick magnitude is the locked 0.30 per char", () => {
    expect(KICK_PER_CHAR).toBeCloseTo(0.3, 5);
  });
});
