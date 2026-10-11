/**
 * Pure math for the voice card's text-reactive speech envelope.
 * Parameters locked from the user-tuned interactive mockups
 * (SPEC: docs/superpowers/specs/2026-06-11-voice-wave-design.md §2).
 * No DOM, no React — unit-testable without a canvas. The WebGL aura
 * (AuraVisual.tsx) owns the rAF loop and feeds dtMs + kick events;
 * a future audio layer (SPEC v0.3 §6.2) feeds the same kick slot.
 */

/** Reference frame duration all per-frame constants are normalized to. */
export const REF_FRAME_MS = 50 / 3; // 16.667ms (60fps)

// — Envelope (SPEC §2 "Envelope") —
export const KICK_PER_CHAR = 0.3;
export const RAW_CLAMP = 1.25;
export const RAW_DECAY_PER_FRAME = 0.93;
export const PUNCTUATION_CUT = 0.3;
export const ATTACK_K = 0.12;
export const RELEASE_K = 0.025;
export const FAST_ATTACK_K = 0.25;
export const FAST_RELEASE_K = 0.06;
export const SLOW_MA_K = 0.02;

export interface EnvelopeState {
  raw: number;
  env: number;
  fast: number;
  slow: number;
}

export const initialEnvelope = (): EnvelopeState => ({
  raw: 0,
  env: 0,
  fast: 0,
  slow: 0,
});

export interface Kicks {
  readonly count: number;
  readonly punctuation: "hard" | "soft" | null;
}

/** Convert a per-REF_FRAME lerp coefficient to an arbitrary dt. */
const lerpK = (k: number, frames: number): number => 1 - (1 - k) ** frames;

/**
 * Advance the envelope by dtMs given the frame's kick events. Mutates
 * `s` in place (one object for the loop's lifetime — no per-frame
 * allocation). Asymmetric attack/release keeps the wave swelling and
 * subsiding smoothly instead of twitching per token; the punctuation
 * cut reads as a breath.
 */
export function stepEnvelope(
  s: EnvelopeState,
  dtMs: number,
  kicks: Kicks,
): void {
  const frames = dtMs / REF_FRAME_MS;
  if (kicks.count > 0) {
    s.raw = Math.min(RAW_CLAMP, s.raw + KICK_PER_CHAR * kicks.count);
  }
  if (kicks.punctuation !== null) s.raw *= PUNCTUATION_CUT;
  s.raw *= RAW_DECAY_PER_FRAME ** frames;
  s.env +=
    (s.raw - s.env) * lerpK(s.raw > s.env ? ATTACK_K : RELEASE_K, frames);
  if (s.env < 0) s.env = 0;
  s.fast +=
    (s.raw - s.fast) *
    lerpK(s.raw > s.fast ? FAST_ATTACK_K : FAST_RELEASE_K, frames);
  if (s.fast < 0) s.fast = 0;
  s.slow += (s.env - s.slow) * lerpK(SLOW_MA_K, frames);
}
