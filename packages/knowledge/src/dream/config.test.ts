import { describe, expect, it } from "vitest";
import { DEFAULT_DREAM_CONFIG, resolveDreamConfig } from "./config.js";

describe("resolveDreamConfig", () => {
  it("returns defaults when given nothing", () => {
    expect(resolveDreamConfig()).toEqual(DEFAULT_DREAM_CONFIG);
  });

  it("overrides only the provided keys", () => {
    const c = resolveDreamConfig({ minVoiceScore: 0.9, maxLiveCount: 3 });
    expect(c.minVoiceScore).toBe(0.9);
    expect(c.maxLiveCount).toBe(3);
    expect(c.model).toBe(DEFAULT_DREAM_CONFIG.model);
  });

  // The automatic pass spends the USER's tokens while they are away, so it is
  // opt-in (owner 2026-09-21). A default that drifts back to ON must break a
  // test, not someone's bill.
  it("Dream's automatic pass is off unless asked for", () => {
    expect(DEFAULT_DREAM_CONFIG.enabled).toBe(false);
    expect(resolveDreamConfig().enabled).toBe(false);
    expect(resolveDreamConfig({ enabled: true }).enabled).toBe(true);
  });

  // Lock the load-bearing trigger-cadence defaults so a silent edit to
  // config.ts (e.g. dropping a zero from cooldownMs, or moving the 25-turn
  // threshold) breaks a test rather than quietly changing how often Dream runs.
  it("pins the concrete trigger-cadence defaults", () => {
    expect(DEFAULT_DREAM_CONFIG.idleMs).toBe(30 * 60_000); // 30 min
    expect(DEFAULT_DREAM_CONFIG.cooldownMs).toBe(7 * 24 * 60 * 60_000); // 7 days
    expect(DEFAULT_DREAM_CONFIG.minRetryMs).toBe(60 * 60_000); // 1 h
    expect(DEFAULT_DREAM_CONFIG.minNewSessions).toBe(5);
    expect(DEFAULT_DREAM_CONFIG.minSessionHertaTurns).toBe(25);
  });

  // Lock the ADR 0023 memory-mechanic defaults the same way: the floor being
  // NON-zero is what the website's fading claim rides on, and the other three
  // knobs decide whether echo/charge/living-fold fire at all.
  it("pins the ADR 0023 memory-mechanic defaults", () => {
    expect(DEFAULT_DREAM_CONFIG.retentionFloor).toBe(0.12); // forgetting ON
    expect(DEFAULT_DREAM_CONFIG.echoMinChars).toBe(12);
    expect(DEFAULT_DREAM_CONFIG.retentionChargeWeight).toBe(0.5);
    expect(DEFAULT_DREAM_CONFIG.semanticizeReactivationThreshold).toBe(3);
  });
});
