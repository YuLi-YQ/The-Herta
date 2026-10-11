import { describe, expect, it } from "vitest";
import {
  applyCloudy,
  CLOUDY,
  CLOUDY_KEY_COLOR,
  cardHourFor,
  DARK_HOUR,
  externalLightAt,
  hourDelta,
  keyElevationAt,
  keyPositionAt,
  lightingAt,
  mixHexColor,
  STATE_TARGETS,
  timeWeights,
} from "./lighting.js";

const at = (h: number, m = 0): Date => new Date(2026, 8, 6, h, m, 0);

describe("device-scene lighting tables (ADR 0057 §2.1b, the pale room)", () => {
  it("covers every device state the flat card knows", () => {
    const states = [
      "idle",
      "delegated",
      "reading",
      "writing",
      "runningCommand",
      "waitingApproval",
      "verifying",
      "succeeded",
      "failed",
    ] as const;
    for (const s of states) {
      expect(STATE_TARGETS[s].color).toMatch(/^#[0-9a-f]{6}$/);
      expect(STATE_TARGETS[s].intensity).toBeGreaterThan(0);
    }
  });

  it("daylight is off after hours and full in the day, with smooth ramps", () => {
    expect(externalLightAt(0)).toBe(0);
    expect(externalLightAt(23)).toBe(0);
    expect(externalLightAt(5)).toBe(0);
    expect(externalLightAt(6.5)).toBeCloseTo(0.5, 5);
    expect(externalLightAt(12)).toBe(1);
    expect(externalLightAt(20)).toBeCloseTo(0.5, 5);
    expect(externalLightAt(22)).toBe(0);
    expect(externalLightAt(-1)).toBe(0); // wraps
  });

  describe("cardHourFor — the clock fold (§2.2)", () => {
    it("light theme: the real day runs the card from its dawn (07:00) to its dusk (18:00)", () => {
      expect(cardHourFor("light", at(6))).toBe(7);
      expect(cardHourFor("light", at(12))).toBeCloseTo(12.5, 9);
      expect(cardHourFor("light", at(18))).toBe(18);
      // Monotone with the real sun through the day.
      let prev = 0;
      for (let h = 6; h <= 18; h += 1) {
        const card = cardHourFor("light", at(h));
        expect(card).toBeGreaterThan(prev);
        prev = card;
      }
    });

    it("light theme: the real night runs back from dusk to dawn, noon-ish at midnight", () => {
      expect(cardHourFor("light", at(20))).toBeCloseTo(18 - 2 * (11 / 12), 9);
      expect(cardHourFor("light", at(0))).toBeCloseTo(12.5, 9);
      expect(cardHourFor("light", at(3))).toBeCloseTo(18 - 9 * (11 / 12), 9);
      expect(cardHourFor("light", at(5, 59))).toBeCloseTo(7.015, 2);
    });

    it("light theme: continuous at dawn, dusk and midnight, never outside daylight", () => {
      expect(cardHourFor("light", at(17, 59))).toBeCloseTo(
        cardHourFor("light", at(18, 1)),
        1,
      );
      expect(cardHourFor("light", at(5, 59))).toBeCloseTo(
        cardHourFor("light", at(6, 1)),
        1,
      );
      expect(cardHourFor("light", at(23, 59))).toBeCloseTo(
        cardHourFor("light", at(0, 1)),
        1,
      );
      for (let h = 0; h < 24; h += 1) {
        for (const m of [0, 15, 30, 45]) {
          const card = cardHourFor("light", at(h, m));
          expect(card).toBeGreaterThanOrEqual(7);
          expect(card).toBeLessThanOrEqual(18);
          // Three quarters lit at the dawn edge, full elsewhere.
          expect(externalLightAt(card)).toBeGreaterThanOrEqual(0.7);
        }
      }
    });

    it("dark theme: midnight whatever the clock says", () => {
      for (const h of [0, 6, 12, 18, 23]) {
        expect(cardHourFor("dark", at(h))).toBe(DARK_HOUR);
      }
      expect(lightingAt(DARK_HOUR).afterHours).toBe(true);
    });
  });

  describe("the key's arc", () => {
    it("keeps the accepted 08:30 morning key (20° up, ~10° left of front) within a tenth", () => {
      const [x, y, z] = keyPositionAt(8.5);
      expect(Math.abs(x - -1.1)).toBeLessThan(0.15);
      expect(Math.abs(y - 4.1)).toBeLessThan(0.15);
      expect(Math.abs(z - 6)).toBeLessThan(0.15);
    });

    it("rises from dawn to noon and falls to dusk, azimuth pinned on the left", () => {
      expect(keyElevationAt(6)).toBeCloseTo((12 * Math.PI) / 180, 6);
      expect(keyElevationAt(12)).toBeCloseTo((50 * Math.PI) / 180, 6);
      expect(keyElevationAt(18)).toBeCloseTo((12 * Math.PI) / 180, 6);
      let prev = keyElevationAt(6);
      for (let h = 6.5; h <= 12; h += 0.5) {
        const e = keyElevationAt(h);
        expect(e).toBeGreaterThanOrEqual(prev);
        prev = e;
      }
      for (const h of [6, 9, 12, 15, 18]) {
        const [x, , z] = keyPositionAt(h);
        expect(x).toBeLessThan(0);
        expect(z).toBeGreaterThan(0);
        expect(Math.atan2(-x, z)).toBeCloseTo(Math.atan2(1.1, 6), 6);
      }
    });
  });

  it("the dark hour is after hours, the softbox follows the key", () => {
    const day = lightingAt(8.5);
    expect(day.afterHours).toBe(false);
    expect(day.external).toBe(1);
    expect(day.adaptation).toBe(1);
    expect(day.contour).toBe(0);
    expect(day.key).toBeGreaterThan(2);
    expect(day.fill).toBeGreaterThan(0.7);
    // The directional stand-in for the study's LTC panel: 0.45 × 0.32 × key.
    expect(day.softbox).toBeCloseTo(day.key * 0.144, 9);
    expect(day.position).toEqual(keyPositionAt(8.5));
    const night = lightingAt(DARK_HOUR);
    expect(night.afterHours).toBe(true);
    expect(night.key).toBe(0);
    expect(night.softbox).toBe(0);
    expect(night.sky).toBe(0);
    expect(night.environment).toBe(0);
    expect(night.contour).toBeCloseTo(0.003, 6);
    expect(night.adaptation).toBe(12);
    expect(night.exposure).toBeCloseTo(0.87 * 12, 6);
  });

  it("the cloudy weather scales the daylight, cools the key, and leaves the night alone (§2.11)", () => {
    const day = lightingAt(12);
    const cloudy = applyCloudy(day);
    expect(cloudy.key).toBeCloseTo(day.key * CLOUDY.key, 9);
    expect(cloudy.softbox).toBeCloseTo(day.softbox * CLOUDY.key, 9);
    expect(cloudy.fill).toBeCloseTo(day.fill * CLOUDY.fill, 9);
    expect(cloudy.rim).toBeCloseTo(day.rim * CLOUDY.rim, 9);
    expect(cloudy.sky).toBeCloseTo(day.sky * CLOUDY.sky, 9);
    expect(cloudy.environment).toBeCloseTo(
      day.environment * CLOUDY.environment,
      9,
    );
    expect(cloudy.backgroundScale).toBe(CLOUDY.background);
    expect(cloudy.cool).toBe(CLOUDY.cool);
    expect(cloudy.cloudDepth).toBe(CLOUDY.cloudDepth);
    expect(cloudy.keyColor).toBe(
      mixHexColor(day.keyColor, CLOUDY_KEY_COLOR, CLOUDY.cool),
    );
    // The bounce breathes with the sky, within its 7 %.
    const bounces = [0, 5, 10, 16.5, 25].map((p) => applyCloudy(day, p).bounce);
    for (const b of bounces) {
      expect(b).toBeLessThanOrEqual(CLOUDY.bounce + 1e-9);
      expect(b).toBeGreaterThanOrEqual(CLOUDY.bounce * 0.93 - 1e-9);
    }
    expect(new Set(bounces.map((b) => b.toFixed(6))).size).toBeGreaterThan(1);
    // Untouched: exposure, rotation, the outline, and everything at night.
    expect(cloudy.exposure).toBe(day.exposure);
    expect(cloudy.contour).toBe(day.contour);
    const night = applyCloudy(lightingAt(DARK_HOUR), 40);
    expect(night).toEqual({
      ...lightingAt(DARK_HOUR),
      backgroundScale: 1,
      bounce: 1,
      cool: 0,
      cloudDepth: 0,
    });
  });

  it("interpolates anchors continuously across the midnight seam", () => {
    const before = lightingAt(23.999);
    const after = lightingAt(0.001);
    expect(Math.abs(before.rotation - after.rotation)).toBeLessThan(1e-3);
    expect(before.background).toBe(after.background);
  });

  it("time weights sum to one and pick the right preset", () => {
    for (const h of [0, 3, 6.5, 8, 10, 13, 15.5, 18, 20, 22, 23.9]) {
      const w = timeWeights(h);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    expect(timeWeights(8)).toEqual([1, 0, 0, 0]);
    expect(timeWeights(13)).toEqual([0, 1, 0, 0]);
    expect(timeWeights(18)).toEqual([0, 0, 1, 0]);
    expect(timeWeights(0)).toEqual([0, 0, 0, 1]);
  });

  it("mixes colours in linear light and clamps", () => {
    expect(mixHexColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHexColor("#000000", "#ffffff", 1)).toBe("#ffffff");
    const mid = Number.parseInt(
      mixHexColor("#000000", "#ffffff", 0.5).slice(1, 3),
      16,
    );
    expect(mid).toBeGreaterThan(128);
  });

  it("hourDelta takes the short way around the clock", () => {
    expect(hourDelta(8.5, 0)).toBeCloseTo(-8.5, 9);
    expect(hourDelta(0, 8.5)).toBeCloseTo(8.5, 9);
    expect(hourDelta(22, 2)).toBeCloseTo(4, 9);
    expect(hourDelta(2, 22)).toBeCloseTo(-4, 9);
  });
});
