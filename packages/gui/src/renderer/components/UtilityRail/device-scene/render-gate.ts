/**
 * The render gate (ADR 0057 §2.10): the loop keeps ticking at its calm
 * rate, but a frame is DRAWN only when the picture would change by an
 * amount a viewer could see. At idle the lamp's breath is shallow (±6.5 %
 * over 3.8 s), so most of the 20 ticks a second would repaint the same
 * card; with the gate the idle card draws about a third of them, working
 * states (a deeper, faster breath) draw every tick, and motion bypasses
 * the gate entirely. Pure, so the rate claims are testable.
 */

/** What the last drawn frame showed, in the loop's own units. */
export interface ShownPicture {
  /** The lamp's displayed intensity (state intensity × breath + flash). */
  readonly ring: number;
  /** The lamp's linear colour channels. */
  readonly color: readonly [number, number, number];
  /** The card hour driving the lighting. */
  readonly hour: number;
  /** The device's lift in design units. */
  readonly lift: number;
  /** The cloud drift in seconds of motion (0 while there are no clouds). */
  readonly cloud: number;
}

/** The lamp must move by this fraction of its shown intensity. 1 % is
 *  under a level of 8-bit output on a lamp this bright, and its bloom
 *  scales with it. */
export const RING_VISIBLE_DELTA = 0.01;
/** A colour channel must move by one 8-bit level (linear, so stricter
 *  than the display's). */
export const COLOR_VISIBLE_DELTA = 1 / 255;
/** The clock must move by a hundredth of a card hour (~40 s of real time
 *  at the fold's rate): the key's elevation changes under 0.3°. */
export const HOUR_VISIBLE_DELTA = 0.01;
/** The cloud field must have drifted about two canvas pixels: it moves
 *  0.045 / 5.5 m per second of phase (scene.ts), 8 mm/s, and the card
 *  shows ~950 px per metre, so a quarter second is ~2 px. Cloud edges are
 *  a smoothstep over low-frequency noise; a 2 px step is under their
 *  softness. Four draws a second while clouds pass. */
export const CLOUD_VISIBLE_PHASE = 0.25;

/** Whether drawing `next` would look different from `shown`. `null` is
 *  "nothing drawn yet" and always draws. */
export function pictureChanged(
  shown: ShownPicture | null,
  next: ShownPicture,
): boolean {
  if (shown === null) return true;
  if (next.lift !== shown.lift) return true;
  if (Math.abs(next.cloud - shown.cloud) >= CLOUD_VISIBLE_PHASE) return true;
  const ringBase = Math.max(Math.abs(shown.ring), 1e-3);
  if (Math.abs(next.ring - shown.ring) / ringBase >= RING_VISIBLE_DELTA) {
    return true;
  }
  for (let i = 0; i < 3; i += 1) {
    const a = next.color[i] ?? 0;
    const b = shown.color[i] ?? 0;
    if (Math.abs(a - b) >= COLOR_VISIBLE_DELTA) return true;
  }
  const hourGap = Math.abs(next.hour - shown.hour);
  return Math.min(hourGap, 24 - hourGap) >= HOUR_VISIBLE_DELTA;
}
