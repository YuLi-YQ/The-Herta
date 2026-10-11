import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  alphaFromStrength,
  BASE_LAYER_STYLE,
  backdropVeil,
  buildCellLayerNames,
  DARK_FOREGROUND,
  decodeBase64ToBytes,
  fontSizeFromStrength,
  GLYPH_SIZE_STEP_PX,
  getBaseAlpha,
  getFontSize,
  getInterpolatedBrightness,
  getStrength,
  getSymbolState,
  OPENING_GLYPHS,
  OPENING_SEGMENT_GEOMETRY,
  openingGlyphSizes,
  precomputeCellTimings,
  quantizeGlyphSize,
  RENDER_OPTIONS,
  resolveLayerStyles,
  revealEnvelope,
  type SegmentData,
  type SegmentLayer,
} from "./ascii-renderer.js";

describe("ascii-renderer helpers", () => {
  it("decodeBase64ToBytes round-trips bytes", () => {
    const bytes = new Uint8Array([0, 127, 255, 8]);
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(decodeBase64ToBytes(b64))).toEqual([0, 127, 255, 8]);
  });

  it("getStrength maps black->1 and white->0", () => {
    expect(getStrength(0)).toBeCloseTo(1, 5);
    expect(getStrength(255)).toBeCloseTo(0, 5);
  });

  it("getInterpolatedBrightness interpolates between adjacent frames", () => {
    // 2 cells, 2 frames. frame0=[0,0] frame1=[100,200]
    const frameBytes = new Uint8Array([0, 0, 100, 200]);
    const activeCount = 2;
    const frameCount = 2;
    // cell 1 at framePosition 0.5 -> midway between 0 (f0) and 200 (f1) = 100
    expect(
      getInterpolatedBrightness(frameBytes, activeCount, frameCount, 1, 0.5),
    ).toBeCloseTo(100, 5);
    // framePosition 1.0 -> frame1 exactly = 200
    expect(
      getInterpolatedBrightness(frameBytes, activeCount, frameCount, 1, 1.0),
    ).toBeCloseTo(200, 5);
  });

  it("getSymbolState is deterministic for identical inputs", () => {
    const a = getSymbolState(3, 7, 40, 0.6);
    const b = getSymbolState(3, 7, 40, 0.6);
    expect(a.currentSymbol).toBe(b.currentSymbol);
    expect(typeof a.currentSymbol).toBe("string");
    expect(a.currentSymbol.length).toBe(1);
  });

  it("holds the LAST frame at end of playback instead of wrapping to frame 0 (M-opening-1)", () => {
    // One-shot playback: at framePosition === frameCount the old
    // `% frameCount` wrap interpolated back toward frame 0 — a pop that
    // was only invisible because the overlay unmounts earlier.
    const frameBytes = new Uint8Array([0, 0, 100, 200]); // f0=[0,0] f1=[100,200]
    expect(getInterpolatedBrightness(frameBytes, 2, 2, 1, 2.0)).toBeCloseTo(
      200,
      5,
    );
    expect(getInterpolatedBrightness(frameBytes, 2, 2, 1, 1.7)).toBeCloseTo(
      200,
      5,
    );
  });
});

describe("ascii-renderer hot-loop equivalences (M-opening-1)", () => {
  // The draw-loop optimizations must be output-identical to the original
  // brightness-based forms — these pins keep that true.

  it("fontSizeFromStrength / alphaFromStrength match the brightness-based forms", () => {
    const style = { ...BASE_LAYER_STYLE, gamma: 1.35, alphaPower: 1.15 };
    for (const brightness of [0, 17, 96, 200, 255]) {
      const strength = getStrength(brightness, style.gamma);
      expect(fontSizeFromStrength(strength, 12, style, 0.7)).toBeCloseTo(
        getFontSize(brightness, 12, style, 0.7),
        10,
      );
      expect(alphaFromStrength(strength, style, 0.7)).toBeCloseTo(
        getBaseAlpha(brightness, style, 0.7),
        10,
      );
    }
  });

  it("precomputeCellTimings feeds getSymbolState to output identical to self-derivation", () => {
    const cells: ReadonlyArray<readonly [number, number, number]> = [
      [3.7, 7.2, 10],
      [120.9, 45.1, 6],
      [0, 0, 8],
    ];
    const timings = precomputeCellTimings(cells);
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (cell === undefined) throw new Error("unreachable");
      const sx = Math.floor(cell[0]);
      const sy = Math.floor(cell[1]);
      expect(timings.seedXs[i]).toBe(sx);
      expect(timings.seedYs[i]).toBe(sy);
      for (const t of [0, 0.37, 1.9]) {
        const derived = getSymbolState(sx, sy, 87, t);
        const precomputed = getSymbolState(
          sx,
          sy,
          87,
          t,
          timings.intervals[i],
          timings.phaseOffsets[i],
        );
        expect(precomputed).toEqual(derived);
      }
    }
  });
});

describe("ascii-renderer reveal envelope", () => {
  it("revealEnvelope is 0 at p=0, 1 in the middle, 0 at p=1", () => {
    expect(revealEnvelope(0)).toBeCloseTo(0, 5);
    expect(revealEnvelope(0.5)).toBeCloseTo(1, 5);
    expect(revealEnvelope(1)).toBeCloseTo(0, 5);
  });

  it("revealEnvelope ramps monotonically up then down", () => {
    expect(revealEnvelope(0.05)).toBeLessThan(revealEnvelope(0.15));
    expect(revealEnvelope(0.85)).toBeGreaterThan(revealEnvelope(0.95));
  });

  it("reveal multiplier scales font size and alpha (0 -> blank)", () => {
    expect(getBaseAlpha(0, BASE_LAYER_STYLE, 0)).toBeCloseTo(0, 5);
    // reveal 0 -> font collapses to the additive minFontSize floor (2.0).
    expect(getFontSize(0, 24, BASE_LAYER_STYLE, 0)).toBeCloseTo(2.0, 5);
    expect(getBaseAlpha(0, BASE_LAYER_STYLE, 1)).toBeCloseTo(
      getBaseAlpha(0),
      5,
    );
    expect(getFontSize(0, 24, BASE_LAYER_STYLE, 1)).toBeCloseTo(
      getFontSize(0, 24),
      5,
    );
  });

  it("base style applies inkOpacity to a fully dark cell", () => {
    // black cell at full reveal -> strength 1 ^ alphaPower * inkOpacity 0.92.
    expect(getBaseAlpha(0)).toBeCloseTo(BASE_LAYER_STYLE.inkOpacity, 5);
  });
});

describe("ascii-renderer layer styles", () => {
  const LAYERS: SegmentLayer[] = [
    { name: "detail", start: 0, count: 3 },
    { name: "coarse", start: 3, count: 2 },
  ];

  it("buildCellLayerNames maps contiguous ranges, default elsewhere", () => {
    expect(buildCellLayerNames(5, LAYERS)).toEqual([
      "detail",
      "detail",
      "detail",
      "coarse",
      "coarse",
    ]);
  });

  it("buildCellLayerNames clamps ranges to the cell count", () => {
    expect(buildCellLayerNames(2, LAYERS)).toEqual(["detail", "detail"]);
  });

  it("buildCellLayerNames returns all-default when there are no layers", () => {
    expect(buildCellLayerNames(3)).toEqual(["default", "default", "default"]);
  });

  it("resolveLayerStyles overrides coarse and falls back to base for detail", () => {
    const styles = resolveLayerStyles(LAYERS);
    expect(styles.default).toEqual(BASE_LAYER_STYLE);
    // detail has no explicit override -> base style.
    expect(styles.detail).toEqual(BASE_LAYER_STYLE);
    // coarse renders as lighter UI ink.
    expect(styles.coarse?.inkOpacity).toBeCloseTo(0.48, 5);
    expect(styles.coarse?.gamma).toBeCloseTo(1.35, 5);
    expect(styles.coarse?.alphaPower).toBeCloseTo(1.15, 5);
    // inherited fields stay from the base style.
    expect(styles.coarse?.foreground).toBe(BASE_LAYER_STYLE.foreground);
  });

  it("coarse ink is lighter than detail ink at the same midtone brightness", () => {
    const styles = resolveLayerStyles(LAYERS);
    const detail = styles.detail ?? BASE_LAYER_STYLE;
    const coarse = styles.coarse ?? BASE_LAYER_STYLE;
    expect(getBaseAlpha(128, coarse)).toBeLessThan(getBaseAlpha(128, detail));
  });

  it("dark mode swaps every layer's foreground to the light ink, nothing else (night mode 2026-07-13)", () => {
    const styles = resolveLayerStyles(LAYERS, true);
    expect(styles.default?.foreground).toBe(DARK_FOREGROUND);
    expect(styles.detail?.foreground).toBe(DARK_FOREGROUND);
    expect(styles.coarse?.foreground).toBe(DARK_FOREGROUND);
    // The reveal must read identically — only the ink color flips.
    expect(styles.default?.inkOpacity).toBe(BASE_LAYER_STYLE.inkOpacity);
    expect(styles.default?.gamma).toBe(BASE_LAYER_STYLE.gamma);
    expect(styles.coarse?.inkOpacity).toBeCloseTo(0.48, 5);
  });
});

describe("ascii-renderer glyph sizes (M-opening-2)", () => {
  it("quantizeGlyphSize rounds to the nearest GLYPH_SIZE_STEP_PX", () => {
    expect(GLYPH_SIZE_STEP_PX).toBe(0.5);
    expect(quantizeGlyphSize(7.24)).toBe(7);
    expect(quantizeGlyphSize(7.26)).toBe(7.5);
    expect(quantizeGlyphSize(12.9)).toBe(13);
  });

  it("openingGlyphSizes lists every size the draw loop can ask for, at any window shape", () => {
    // The draw loop's own arithmetic, swept over strength, cell size, reveal
    // and every layer style: a size missing from the glyph sheet would leave
    // the sheet unused, and the opening drawing text.
    const missing: string[] = [];
    for (const [w, h] of [
      [1440, 900],
      [1280, 720],
      [2560, 1440],
      [900, 1200],
    ] as const) {
      const sizes = new Set(openingGlyphSizes(w, h));
      const scale = Math.min(
        w / OPENING_SEGMENT_GEOMETRY.width,
        h / OPENING_SEGMENT_GEOMETRY.height,
      );
      for (const style of Object.values(resolveLayerStyles())) {
        for (
          let cell = 1;
          cell <= OPENING_SEGMENT_GEOMETRY.maxCellSize;
          cell++
        ) {
          for (let i = 0; i <= 20; i += 1) {
            for (const reveal of [0, 0.3, 1]) {
              const px =
                fontSizeFromStrength(i / 20, cell, style, reveal) * scale;
              if (px < style.minDrawFontSize) continue;
              if (!sizes.has(quantizeGlyphSize(px)))
                missing.push(`${w}×${h} ${px}`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every committed opening segment has the geometry the glyph sheet is drawn to", () => {
    const dir = fileURLToPath(
      new URL("../../upstream-assets/openings/", import.meta.url),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const segment = JSON.parse(
        readFileSync(join(dir, file), "utf8"),
      ) as SegmentData;
      expect([file, segment.width, segment.height]).toEqual([
        file,
        OPENING_SEGMENT_GEOMETRY.width,
        OPENING_SEGMENT_GEOMETRY.height,
      ]);
      const largest = segment.cells.reduce((m, c) => Math.max(m, c[2]), 0);
      expect(largest).toBeLessThanOrEqual(OPENING_SEGMENT_GEOMETRY.maxCellSize);
    }
  });

  it("OPENING_GLYPHS holds every symbol of every group", () => {
    for (const group of RENDER_OPTIONS.charGroups) {
      for (const symbol of group.chars)
        expect(OPENING_GLYPHS).toContain(symbol);
    }
  });
});

describe("ascii-renderer backdrop veil", () => {
  it("is opaque white (1) at p=0", () => {
    expect(backdropVeil(0)).toBeCloseTo(1, 5);
  });

  it("settles to the frosted alpha once past the in-portion", () => {
    expect(backdropVeil(0.2)).toBeCloseTo(0.35, 5); // p === inPortion (0.2)
    expect(backdropVeil(0.5)).toBeCloseTo(0.35, 5);
    expect(backdropVeil(1)).toBeCloseTo(0.35, 5);
  });

  it("decreases monotonically across the develop-in ramp", () => {
    expect(backdropVeil(0.05)).toBeGreaterThan(backdropVeil(0.15));
    expect(backdropVeil(0.15)).toBeGreaterThan(backdropVeil(0.24));
  });
});
