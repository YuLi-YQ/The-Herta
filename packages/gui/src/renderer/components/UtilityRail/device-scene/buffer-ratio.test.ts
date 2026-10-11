import { describe, expect, it } from "vitest";
import {
  bufferPixelRatio,
  MAX_LONG_EDGE_PX,
  renderPixelRatio,
} from "./buffer-ratio.js";

/** The rail card's canvas (CARD_BOX_CSS in scene.ts). */
const CARD = { width: 336, height: 328 } as const;

describe("the live card's buffer ratio", () => {
  it("supersamples a DPR-1 display to 1.5×", () => {
    expect(renderPixelRatio(CARD.width, CARD.height, 1)).toBe(1.5);
  });

  it("honours the display up to 2× and no further", () => {
    expect(renderPixelRatio(CARD.width, CARD.height, 2)).toBe(2);
    expect(renderPixelRatio(CARD.width, CARD.height, 3)).toBe(2);
  });

  it("caps the long edge at 768 px, and never drops under 1×", () => {
    expect(renderPixelRatio(600, 400, 2)).toBeCloseTo(MAX_LONG_EDGE_PX / 600);
    expect(renderPixelRatio(1000, 600, 2)).toBe(1);
  });
});

describe("the ratio the scene draws at", () => {
  it("is the live guard when nothing drives the scene", () => {
    expect(bufferPixelRatio(undefined, CARD.width, CARD.height, 1)).toBe(1.5);
    expect(bufferPixelRatio(undefined, CARD.width, CARD.height, 3)).toBe(2);
  });

  it("is the driven caller's own — a film's macro asks for 8× and gets 8×", () => {
    // Pre-fix this answered 2: the live guard ran in driven mode too, and the
    // page magnified a 2× buffer fourfold (the stair-stepped ring).
    expect(
      bufferPixelRatio({ pixelRatio: 8 }, CARD.width, CARD.height, 1),
    ).toBe(8);
  });

  it("does not round a driven ratio up to the live floor of 1.5×", () => {
    // The v0.1.5 film's docked card: stage 2× × dock 0.74.
    expect(
      bufferPixelRatio({ pixelRatio: 1.48 }, CARD.width, CARD.height, 1),
    ).toBe(1.48);
  });

  it("ignores the display and the canvas size when driven", () => {
    expect(bufferPixelRatio({ pixelRatio: 4 }, 1000, 1000, 3)).toBe(4);
  });

  it("floors a driven ratio at 1×", () => {
    expect(
      bufferPixelRatio({ pixelRatio: 0.5 }, CARD.width, CARD.height, 2),
    ).toBe(1);
  });
});
