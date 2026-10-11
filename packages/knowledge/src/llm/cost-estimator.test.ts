import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  formatCostUsd,
  MODEL_RATES,
} from "./cost-estimator.js";

describe("estimateCostUsd", () => {
  it("computes USD = (input/M)*inputRate + (output/M)*outputRate", () => {
    const cost = estimateCostUsd({
      model: "deepseek-v4-pro",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(MODEL_RATES["deepseek-v4-pro"].inputUsdPerMTok, 4);
  });

  it("supports calls × per-call estimates", () => {
    const cost = estimateCostUsd({
      model: "deepseek-v4-pro",
      calls: 100,
      inputTokensPerCall: 30_000,
      outputTokensPerCall: 5_000,
    });
    const expectedInput = (100 * 30_000) / 1_000_000;
    const expectedOutput = (100 * 5_000) / 1_000_000;
    const rates = MODEL_RATES["deepseek-v4-pro"];
    expect(cost).toBeCloseTo(
      expectedInput * rates.inputUsdPerMTok +
        expectedOutput * rates.outputUsdPerMTok,
      4,
    );
  });

  it("throws on unknown model", () => {
    expect(() =>
      estimateCostUsd({ model: "fake-model", inputTokens: 1, outputTokens: 0 }),
    ).toThrow(/unknown model/i);
  });
});

describe("formatCostUsd", () => {
  it("formats with $ prefix and 2 decimals", () => {
    expect(formatCostUsd(1.5)).toBe("$1.50");
    expect(formatCostUsd(0.001)).toBe("$0.00");
  });
});
