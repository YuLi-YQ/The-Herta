import { describe, expect, it } from "vitest";
import { resolveDreamConfig } from "./config.js";
import { computeStrength } from "./retention.js";
import type { DreamCreatedRecord } from "./types.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

const mk = (extra: Partial<DreamCreatedRecord> = {}): DreamCreatedRecord => ({
  id: "1",
  file: "### 废案_01：t.txt",
  nn: 1,
  state: "live",
  sourceSessionId: "s",
  sourceEpisodeHash: "h",
  sourceEpisodes: ["h"],
  runId: "r",
  model: "m",
  generatedAt: "2026-07-01T00:00:00Z",
  situationTag: "tag",
  summary: "摘要",
  critiqueScores: { voice: 0.9, format: 1, novelty: 1 },
  validateFeianPassed: true,
  reactivationCount: 0,
  ...extra,
});

describe("computeStrength", () => {
  const cfg = resolveDreamConfig({
    retentionHalfLifeDays: 30,
    retentionReactivationK: 0.5,
  });

  it("equals salience when fresh, un-reactivated (no decay, no bump)", () => {
    // generatedAt == now → Δ=0 → decay=1, reactivations=0 → usefulness=1.
    expect(
      computeStrength(
        mk({ critiqueScores: { voice: 0.9, format: 1, novelty: 1 } }),
        NOW,
        cfg,
      ),
    ).toBeCloseTo(0.9, 6);
  });

  it("decays to ~half salience at exactly one half-life", () => {
    const rec = mk({ generatedAt: "2026-06-01T00:00:00Z" }); // 30 days before NOW
    expect(computeStrength(rec, NOW, cfg)).toBeCloseTo(0.9 * 0.5, 3);
  });

  it("decreases monotonically as the record ages", () => {
    const fresh = computeStrength(
      mk({ generatedAt: "2026-07-01T00:00:00Z" }),
      NOW,
      cfg,
    );
    const older = computeStrength(
      mk({ generatedAt: "2026-06-01T00:00:00Z" }),
      NOW,
      cfg,
    );
    const oldest = computeStrength(
      mk({ generatedAt: "2026-05-01T00:00:00Z" }),
      NOW,
      cfg,
    );
    expect(fresh).toBeGreaterThan(older);
    expect(older).toBeGreaterThan(oldest);
  });

  it("increases with reactivationCount, but concavely (diminishing returns)", () => {
    const base = mk({ generatedAt: "2026-07-01T00:00:00Z" });
    const s0 = computeStrength({ ...base, reactivationCount: 0 }, NOW, cfg);
    const s1 = computeStrength({ ...base, reactivationCount: 1 }, NOW, cfg);
    const s2 = computeStrength({ ...base, reactivationCount: 2 }, NOW, cfg);
    expect(s1).toBeGreaterThan(s0);
    expect(s2).toBeGreaterThan(s1);
    // Concave: the 0→1 gain exceeds the 1→2 gain.
    expect(s1 - s0).toBeGreaterThan(s2 - s1);
  });

  it("uses lastReactivatedAt (not generatedAt) as the decay anchor when present", () => {
    // Old birth but recently reactivated → decay clock reset → near-full strength.
    const rec = mk({
      generatedAt: "2026-01-01T00:00:00Z",
      lastReactivatedAt: "2026-07-01T00:00:00Z",
      reactivationCount: 1,
    });
    // decay≈1, usefulness = 1 + 0.5·ln(2) ≈ 1.3466 → strength ≈ 0.9·1.3466.
    expect(computeStrength(rec, NOW, cfg)).toBeCloseTo(
      0.9 * (1 + 0.5 * Math.log(2)),
      4,
    );
  });

  it("does not go negative or NaN on an unparseable anchor (treats as no decay)", () => {
    const rec = mk({ generatedAt: "not-a-date", lastReactivatedAt: undefined });
    const s = computeStrength(rec, NOW, cfg);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeCloseTo(0.9, 6); // salience, no decay, no bump
  });

  it("skips decay when half-life is 0 (guard against divide-by-zero)", () => {
    const noDecay = resolveDreamConfig({ retentionHalfLifeDays: 0 });
    const rec = mk({ generatedAt: "2026-01-01T00:00:00Z" }); // very old
    expect(computeStrength(rec, NOW, noDecay)).toBeCloseTo(0.9, 6);
  });
});

describe("computeStrength — affect-weighted salience (ADR 0023)", () => {
  const cfg = resolveDreamConfig({
    retentionHalfLifeDays: 30,
    retentionReactivationK: 0.5,
  });

  it("multiplies salience by (1 + w·charge)", () => {
    // Fresh, un-reactivated: 0.9 · (1 + 0.5·0.8) = 1.26.
    const rec = mk({ emotionalCharge: 0.8 });
    expect(computeStrength(rec, NOW, cfg)).toBeCloseTo(0.9 * 1.4, 6);
  });

  it("a legacy record without a stored charge is byte-identical to pure voice", () => {
    expect(computeStrength(mk(), NOW, cfg)).toBeCloseTo(0.9, 6);
  });

  it("weight 0 restores pure voice even when a charge is stored", () => {
    const noWeight = resolveDreamConfig({
      retentionHalfLifeDays: 30,
      retentionChargeWeight: 0,
    });
    expect(
      computeStrength(mk({ emotionalCharge: 0.9 }), NOW, noWeight),
    ).toBeCloseTo(0.9, 6);
  });

  it("the charge multiplier composes with decay (a charged memory outlives a flat one)", () => {
    const flat = mk({ generatedAt: "2026-06-01T00:00:00Z" }); // one half-life
    const charged = mk({
      generatedAt: "2026-06-01T00:00:00Z",
      emotionalCharge: 1,
    });
    expect(computeStrength(flat, NOW, cfg)).toBeCloseTo(0.9 * 0.5, 3);
    expect(computeStrength(charged, NOW, cfg)).toBeCloseTo(0.9 * 1.5 * 0.5, 3);
  });
});
