import { describe, expect, it } from "vitest";
import {
  confineHorizontally,
  downsampleToStraight,
  lampLayer,
  meanChannel,
  measureOpaqueBox,
  peakChannel,
  type RgbaBytes,
  shadowLayer,
  unpadRows,
} from "./art-export-math.js";

function rgba(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): RgbaBytes {
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out.set(fill(x, y), (y * width + x) * 4);
    }
  }
  return out;
}

describe("unpadRows (the WebGPU readback's 256-byte rows)", () => {
  it("takes the stride from the buffer's own length: padded rows are unpadded, tight rows copied", () => {
    const width = 3; // 12-byte rows, padded to 256
    const height = 2;
    const padded = new Uint8Array(256 + 12);
    padded.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0);
    padded.set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32], 256);
    const out = unpadRows(padded, width, height);
    expect(out.length).toBe(24);
    expect([...out.subarray(0, 12)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect([...out.subarray(12, 24)]).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ]);
    const tight = new Uint8Array(24).map((_, i) => i);
    expect([...unpadRows(tight, width, height)]).toEqual([...tight]);
  });
});

describe("downsampleToStraight", () => {
  it("averages an opaque block plainly", () => {
    const src = rgba(2, 2, (x, y) => [x * 100, y * 100, 50, 255]);
    const { pixels, width, height } = downsampleToStraight(src, 2, 2, 2);
    expect([width, height]).toEqual([1, 1]);
    expect([...pixels]).toEqual([50, 50, 50, 255]);
  });

  it("divides a premultiplied edge block by its coverage: the colour survives, the alpha is the coverage", () => {
    // Two of four samples covered by a (200, 100, 0) surface; the other two
    // are the transparent clear. Premultiplied in: colour × coverage.
    const src = rgba(2, 2, (x) =>
      x === 0 ? [200, 100, 0, 255] : [0, 0, 0, 0],
    );
    const { pixels } = downsampleToStraight(src, 2, 2, 2);
    expect([...pixels]).toEqual([200, 100, 0, 128]);
  });

  it("leaves a fully transparent block black at alpha 0", () => {
    const src = rgba(2, 2, () => [0, 0, 0, 0]);
    expect([...downsampleToStraight(src, 2, 2, 2).pixels]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe("shadowLayer", () => {
  it("is the darkening ratio as alpha, divided by the CSS opacity, black", () => {
    const lit = rgba(1, 1, () => [200, 200, 200, 255]);
    const shaded = rgba(1, 1, () => [100, 100, 100, 255]);
    // Half as bright → 50 % darkening → shown at 0.85 opacity needs 0.588.
    const out = shadowLayer(shaded, lit, 0.85);
    expect([...out.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect(out[3]).toBe(Math.round((0.5 / 0.85) * 255));
  });

  it("is transparent where nothing changed, and never brightens", () => {
    const a = rgba(1, 1, () => [180, 170, 160, 255]);
    expect(shadowLayer(a, a, 0.85)[3]).toBe(0);
    const brighter = rgba(1, 1, () => [220, 220, 220, 255]);
    expect(shadowLayer(brighter, a, 0.85)[3]).toBe(0);
  });
});

describe("lampLayer", () => {
  it("is the lamp's addition per channel, floored at zero, opaque", () => {
    const on = rgba(1, 1, () => [120, 110, 100, 255]);
    const off = rgba(1, 1, () => [100, 100, 100, 255]);
    expect([...lampLayer(on, off)]).toEqual([20, 10, 0, 255]);
    expect(peakChannel(lampLayer(on, off))).toBe(20);
  });

  it("meanChannel averages the brightest channel over the covered pixels only", () => {
    const layer = rgba(2, 1, (x) =>
      x === 0 ? [40, 10, 0, 255] : [0, 0, 0, 0],
    );
    expect(meanChannel(layer)).toBe(40);
    const opaque = rgba(2, 1, (x) =>
      x === 0 ? [40, 10, 0, 255] : [0, 0, 20, 255],
    );
    expect(meanChannel(opaque)).toBe(30);
  });
});

describe("confineHorizontally", () => {
  it("keeps the alpha inside the box, fades it over the margin, and zeroes it beyond", () => {
    const src = rgba(10, 1, () => [0, 0, 0, 200]);
    const out = confineHorizontally(
      src,
      10,
      1,
      { left: 0.3, top: 0, right: 0.7, bottom: 1 },
      0.2,
    );
    const alphas = [...out].filter((_, i) => i % 4 === 3);
    // Columns 3–6 (0.35–0.65) lie inside; 0 and 9 lie a full margin out.
    expect(alphas.slice(3, 7)).toEqual([200, 200, 200, 200]);
    expect(alphas[0]).toBe(0);
    expect(alphas[9]).toBe(0);
    expect(alphas[1]).toBeGreaterThan(0);
    expect(alphas[1]).toBeLessThan(200);
    expect(alphas[1]).toBe(alphas[8]);
    // The colour channels are untouched.
    expect(out[0]).toBe(0);
  });
});

describe("measureOpaqueBox", () => {
  it("finds the opaque extent as fractions with exclusive far edges", () => {
    const src = rgba(10, 10, (x, y) =>
      x >= 2 && x <= 6 && y >= 3 && y <= 8 ? [0, 0, 0, 255] : [0, 0, 0, 0],
    );
    expect(measureOpaqueBox(src, 10, 10)).toEqual({
      left: 0.2,
      top: 0.3,
      right: 0.7,
      bottom: 0.9,
    });
  });

  it("ignores alpha under the threshold and reports null for an empty image", () => {
    const faint = rgba(4, 4, () => [0, 0, 0, 10]);
    expect(measureOpaqueBox(faint, 4, 4)).toBeNull();
    expect(measureOpaqueBox(faint, 4, 4, 5)).toEqual({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    });
  });
});
