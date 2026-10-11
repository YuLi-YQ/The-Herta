/**
 * The drawing buffer's pixels per CSS pixel (ADR 0057 §2.4, §2.15).
 *
 * Two callers, two policies. The LIVE card is drawn every breath on whatever
 * GPU the machine has, so its buffer is budgeted: at least 1.5× (a DPR-1
 * display still gets a supersampled card), at most 2×, and never a long edge
 * past 768 px. A DRIVEN scene (a film renderer, a still — §2.15) draws one
 * moment at a time with no frame budget to keep, and the caller sizes the
 * buffer for its own stage: the ratio it names is the ratio it gets.
 *
 * Until 2026-09-18 the driven ratio went through the live guard as well, so
 * a caller that asked for 8× to stand close to the indicator drew 2× and the
 * page magnified it — the second trailer's first dawn still showed the ring
 * stair-stepped. Pure, so the rule has a test; the scene itself needs a GPU.
 */

/** The study's card-mode buffer policy: ≥1.5× at DPR 1, honour up to 2×,
 *  cap the long edge at 768 px. */
export const MAX_LONG_EDGE_PX = 768;

/** The live card's ratio for a canvas of `width` × `height` CSS px on a
 *  display of `dpr`. */
export function renderPixelRatio(
  width: number,
  height: number,
  dpr: number,
): number {
  const desired = Math.max(1.5, dpr);
  return Math.max(
    1,
    Math.min(2, desired, MAX_LONG_EDGE_PX / Math.max(width, height, 1)),
  );
}

/** The ratio the scene draws at: the caller's own when it is driven (floor
 *  1 — a buffer smaller than the canvas is never what a caller means), the
 *  live guard otherwise. A driven caller owns its memory: nothing clamps it. */
export function bufferPixelRatio(
  driven: { readonly pixelRatio: number } | undefined,
  width: number,
  height: number,
  dpr: number,
): number {
  if (driven !== undefined) return Math.max(1, driven.pixelRatio);
  return renderPixelRatio(width, height, dpr);
}
