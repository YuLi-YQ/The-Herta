import { describe, expect, it } from "vitest";
import { OPENING_GLYPHS, openingGlyphSizes } from "./ascii-renderer.js";
import {
  layoutOpeningSheet,
  OPENING_SHEET_MAX_HEIGHT,
  OPENING_SHEET_WIDTH,
} from "./glyph-sheet-layout.js";

describe("layoutOpeningSheet (M-opening-4)", () => {
  it.each([
    [1440, 900, 1],
    [1440, 900, 2],
    [2560, 1440, 1.5],
    [1280, 720, 1.25],
  ])("gives every glyph at every size of a %i×%i window at %s× its own cell, inside the sheet", (w, h, dpr) => {
    const sizes = openingGlyphSizes(w, h);
    const layout = layoutOpeningSheet(sizes, dpr, OPENING_GLYPHS.length);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.entries.map((e) => e.px)).toEqual(sizes);
    const cells: Array<[number, number, number, number]> = [];
    for (const entry of layout.entries) {
      const dev = entry.px * dpr;
      // Room for the widest and tallest symbols, and their antialiasing.
      expect(entry.w).toBeGreaterThanOrEqual(dev * 0.8 + 4);
      expect(entry.h).toBeGreaterThanOrEqual(dev * 1.4 + 4);
      expect(entry.pos).toHaveLength(OPENING_GLYPHS.length * 2);
      for (let g = 0; g < OPENING_GLYPHS.length; g += 1) {
        const x = entry.pos[2 * g] ?? -1;
        const y = entry.pos[2 * g + 1] ?? -1;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x + entry.w).toBeLessThanOrEqual(OPENING_SHEET_WIDTH);
        expect(y + entry.h).toBeLessThanOrEqual(layout.height);
        cells.push([x, y, entry.w, entry.h]);
      }
    }
    // No two cells overlap: the shelf packing places them left to right,
    // row under row, so sorting by row then column makes any overlap a
    // neighbour's.
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (let i = 1; i < cells.length; i += 1) {
      const [px, py, pw] = cells[i - 1] as [number, number, number, number];
      const [x, y] = cells[i] as [number, number, number, number];
      if (y === py) expect(x).toBeGreaterThanOrEqual(px + pw);
    }
    expect(layout.height).toBeLessThanOrEqual(OPENING_SHEET_MAX_HEIGHT);
  });

  it("has no sheet when a cell is wider than the sheet or the sheet too tall", () => {
    expect(layoutOpeningSheet([3000], 1, 4)).toBeNull();
    expect(layoutOpeningSheet(openingGlyphSizes(3840, 2160), 4, 52)).toBeNull();
    expect(layoutOpeningSheet([], 1, 52)).toBeNull();
  });
});
