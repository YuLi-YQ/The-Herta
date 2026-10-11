import { useEffect, useRef, useState } from "react";

/** Per-frame ceiling on revealed characters. Chosen so 60fps × this exceeds
 *  the fastest INTENDED sink cadence — steady streaming at ~12 chars/s
 *  (SLOW_MS_PER_CHAR=80ms) — so normal paced speech passes through ~1:1 and
 *  is NOT throttled. The cap engages only on TRUE single-frame bursts that
 *  bypass sink pacing: recovery-ladder replay chunks and IPC clumping that
 *  deliver many chars in one tick. 3/frame ≈ 180 chars/s keeps such a
 *  burst's bubble-height growth readable instead of a multi-line jump.
 *  Counted in UTF-16 units in useRevealedText and code points in
 *  useRetractMorph's fill — equivalent for Herta's BMP text. */
export const MAX_REVEAL_PER_FRAME = 3;

/** Per-frame ceiling for an EN (`word`) stream. The server already re-paces EN
 *  speech into whole-WORD deltas at a word rhythm (BusActorStreamingSink, mode
 *  `word`), so the renderer's only job is to reveal each delta PROMPTLY rather
 *  than re-throttle it into a letter-by-letter fill — a normal word (≤ this
 *  many code points) pops in a single frame. The cap still bounds a one-frame
 *  paint of a fence / flush-tail mega-delta (~48 × 60 ≈ 2880 cp/s). Because the
 *  server never delivers a PARTIAL word, revealing everything buffered can never
 *  paint half a word, so no completion signal or word-hold is needed here. */
export const EN_MAX_REVEAL_PER_FRAME = 48;

/**
 * Smoothly reveals a growing target string at a steady per-frame rate, so that
 * bursty arrival (DeepSeek tokens paced server-side but clumped by IPC /
 * main-loop jitter) is displayed as an even typewriter fill instead of jumping
 * several characters at once. Returns the revealed prefix of `target`.
 *
 * The bubble that renders this prefix stays content-sized, so it grows smoothly
 * in both width and height and never clips the text — the evenness comes from
 * pacing the reveal, not from animating the box size.
 *
 * Each frame it advances toward the target by ~1/4 of the remaining gap (min 1,
 * max MAX_REVEAL_PER_FRAME chars): it tracks steady input within a couple of
 * characters and drains a burst over a few frames rather than dumping it. A
 * null target or reduced motion reveals instantly.
 *
 * `lang === "en"` switches to the WORD-stream rule: the server already paces EN
 * speech into whole-word deltas, so the renderer reveals up to
 * EN_MAX_REVEAL_PER_FRAME code points per frame (a normal word pops in one
 * frame) instead of the 1/4-gap letter fill. zh / omitted `lang` is unchanged.
 */
export function useRevealedText(
  target: string | null,
  reduced: boolean,
  lang?: "zh" | "en",
): string | null {
  const [len, setLen] = useState(0);
  const targetRef = useRef("");
  targetRef.current = target ?? "";
  const lenRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) {
      lenRef.current = 0;
      setLen(0);
      return;
    }
    if (reduced) {
      lenRef.current = target.length;
      setLen(target.length);
      return;
    }
    // A target shorter than what's already shown (a fresh turn replacing a
    // longer one) snaps back rather than "rewinding".
    if (lenRef.current > target.length) {
      lenRef.current = target.length;
      setLen(target.length);
    }
    const tick = (): void => {
      const full = targetRef.current.length;
      if (lenRef.current >= full) {
        rafRef.current = null;
        return;
      }
      const gap = full - lenRef.current;
      // EN: reveal each server-paced word delta promptly (up to a generous
      // per-frame cap); zh: the even 1/4-gap letter fill that smooths bursty
      // token arrival. Both always advance ≥1 while len < full, so the loop
      // terminates (no spin) and the final delta is never stranded.
      const step =
        lang === "en"
          ? Math.min(gap, EN_MAX_REVEAL_PER_FRAME)
          : Math.min(MAX_REVEAL_PER_FRAME, Math.max(1, Math.ceil(gap / 4)));
      lenRef.current = Math.min(full, lenRef.current + step);
      setLen(lenRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, reduced, lang]);

  if (target === null) return null;
  // Never split a surrogate pair: `len` advances in UTF-16 units, so a slice
  // boundary can land mid-pair on a non-BMP char (emoji), painting a lone
  // surrogate (U+FFFD) for one frame. Round the boundary OUT of the pair.
  let end = Math.min(len, target.length);
  const code = target.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end < target.length) end += 1;
  return target.slice(0, end);
}
