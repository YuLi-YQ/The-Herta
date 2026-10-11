import { useEffect, useRef, useState } from "react";
import {
  EN_MAX_REVEAL_PER_FRAME,
  MAX_REVEAL_PER_FRAME,
} from "./useRevealedText.js";

/** Floor (max-speed) per-character delay of the erase phase: the erase eases
 *  DOWN to this from a slower start. Matches the CLI's 25 ms/char cadence. */
const SHRINK_MS_PER_CHAR = 25;
/** Slowest per-character delay — the erase begins here and eases down to the
 *  SHRINK_MS_PER_CHAR floor, so the retract starts gently and accelerates
 *  (user 2026-06-14). */
const SHRINK_START_MS = 95;
/** Number of deletions over which the per-char delay ramps from the slow
 *  start to the fast floor (linear ease). */
const SHRINK_RAMP_CHARS = 8;
/** Frame cadence of the fill phase (~60fps interval; setInterval rather than
 *  rAF so fake-timer tests drive it and no re-arm bookkeeping is needed). */
const FILL_FRAME_MS = 16;
/**
 * Brief beat between the veto landing and the erase beginning. The retract
 * used to HOLD here until the (silently-generated) veto-retry text arrived,
 * which read as a multi-second dead pause before anything moved. Instead we
 * pause just long enough to register as "she caught herself", then start
 * erasing — toward the divergence if the retry is already in, toward empty if
 * it isn't yet (user 2026-06-14). Exported for the timing tests.
 */
export const RETRACT_HOLD_MS = 300;

/**
 * How long the erase may stay DECELERATED before giving up on the retry and
 * finishing at full speed (the pre-2026-07-27 behaviour).
 *
 * A deadline, not a guess at the rethink's duration: the slowdown exists so
 * the common prefix survives, and every path that produces no retry at all —
 * an empty-recovery ladder, a failed respeak, an interrupt — must still reach
 * empty rather than crawling until the record block snaps over it. Generous
 * enough to cover a normal rethink + time-to-first-divergent-token.
 */
export const RETRACT_WAIT_MAX_MS = 9000;

/**
 * Ceiling on the per-character delay while the divergence is still UNKNOWN.
 *
 * With no floor yet the erase DECELERATES as it goes deeper (see
 * `unknownDelayMs`) instead of running to empty: it keeps moving the whole
 * time, but each character costs more than the last, so the tail lasts long
 * enough for the rethink to land. This caps how slow that gets — past it the
 * erase would read as stalled, which is the thing deceleration exists to
 * avoid.
 */
export const UNKNOWN_MAX_DELAY_MS = 300;

/**
 * Per-character delay while the divergence is unknown: the normal ramped
 * delay scaled by how much of the prefix is already gone.
 *
 * `shown / pos` is 1 at the start (no slowdown — the retract still snaps into
 * motion the instant it lands) and grows hyperbolically as `pos` approaches
 * 0, so the erase gives up the first half quickly and the rest ever more
 * slowly. Total time to empty diverges like the harmonic series rather than
 * being linear, which is exactly the shape needed: fast enough to read as
 * "caught herself", slow enough that the deep tail is still there when the
 * respeak finally says how much of it was shared.
 */
export function unknownDelayMs(args: {
  readonly base: number;
  readonly shown: number;
  readonly pos: number;
}): number {
  const decel = args.shown / Math.max(args.pos, 1);
  return Math.min(UNKNOWN_MAX_DELAY_MS, Math.round(args.base * decel));
}

/**
 * The erase delay (ms) before deleting the `erasedCount`-th character
 * (0-based): a linear ease from SHRINK_START_MS down to the
 * SHRINK_MS_PER_CHAR floor over the first SHRINK_RAMP_CHARS deletions, so the
 * erase starts slow and accelerates to its max speed. Exported for the
 * timing tests.
 */
export function shrinkDelayMs(erasedCount: number): number {
  const t = Math.min(1, erasedCount / SHRINK_RAMP_CHARS);
  return Math.round(
    SHRINK_START_MS - (SHRINK_START_MS - SHRINK_MS_PER_CHAR) * t,
  );
}

/** Code-point length of the longest common prefix of `a` and `b`
 *  (surrogate-safe — compares `[...str]` elements, not UTF-16 units). */
export function commonPrefixLen(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const max = Math.min(ca.length, cb.length);
  let i = 0;
  while (i < max && ca[i] === cb[i]) i += 1;
  return i;
}

/**
 * Two-phase prefix-preserving morph for a supervisor-veto retract
 * (SPEC: docs/superpowers/specs/2026-06-10-veto-prefix-retraction-design.md).
 *
 * Phase "shrink": after a short `RETRACT_HOLD_MS` beat (so the retract reads
 * as "caught herself" rather than an abrupt snap), starting from the prefix
 * that was on screen when the veto landed (`revealed`, sampled at the retract
 * rising edge), delete one code point per step — the per-step delay easing
 * from a slow start down to a 25 ms/char floor, so the erase accelerates as it
 * runs (user 2026-06-14) — stopping as soon as the position is covered by the
 * confirmed common prefix with the (incrementally arriving) retry text.
 *
 * While the divergence is UNKNOWN the erase DECELERATES with depth
 * (`unknownDelayMs`) rather than running at full speed — the 2026-07-27 fix
 * for the morph having become unreachable. The two-stage rethink (2026-07-18)
 * put a whole model call between the veto and the respeak: the floor arrives
 * seconds late, the erase covers ~40 chars/second, and for any ordinary line
 * it reached EMPTY long before the divergence was known, so every veto
 * degraded into wipe-then-retype and the shared prefix this hook exists to
 * preserve was never visible (owner 2026-07-27, against real sessions where
 * the divergence is usually NOT 0). Decelerating spends the first half of the
 * prefix quickly and the rest ever more slowly, so the deep tail is still
 * there when the respeak says how much of it was shared — and the moment
 * either signal lands the cadence returns to normal and converges.
 *
 * Two alternatives were tried and rejected, both for the same reason — they
 * stop the motion. Waiting outright freezes the bubble: nothing else moves
 * during the rethink, since thought tokens never reach the renderer
 * (`streamHertaToken` drops non-speech surfaces) and a non-null
 * `streamingText` suppresses the in-flight galaxy row, so it is exactly the
 * dead pause 2026-06-14 removed. Erasing half and PARKING there is the same
 * freeze with extra steps, and picks an arbitrary halfway point besides.
 * Deceleration keeps the retract continuously alive and needs no such
 * constant.
 *
 * `RETRACT_WAIT_MAX_MS` bounds the slowdown: with no retry EVER
 * (empty-recovery ladder, failed respeak, interrupt) the erase finishes at
 * full speed exactly as it did before, so no path can strand the vetoed text
 * on screen. When the erase does overshoot a late divergence, the fill
 * re-types it — unchanged.
 *
 * Phase "fill": type the retry text forward from the stop position, advancing
 * toward the (still growing) retry length by min(MAX_REVEAL_PER_FRAME,
 * max(1, ceil(gap/4))) per frame — the same pacing rule as useRevealedText.
 * If the shrink overshot the divergence (retry arrived late), the fill simply
 * re-types the lost matching characters — no jump.
 *
 * Returns the string to display while `retracting`; null otherwise. Reduced
 * motion skips animation entirely and mirrors retryText directly. The morph
 * never ends itself — record/turn events clear `retracting` in the store
 * (finalized herta block, or the turn finished/failed safety nets).
 */
export function useRetractMorph(args: {
  retracting: boolean;
  /** The vetoed candidate (streamingText) — the shrink source. */
  vetoed: string | null;
  /** The retry's accumulated deltas (SessionStore.retryText). */
  retryText: string | null;
  /** The currently displayed prefix (useRevealedText output); sampled at the
   *  retract rising edge to seed the shrink position. */
  revealed: string | null;
  /** Server-computed divergence index (SessionStore.retractKeepLen): the floor
   *  the backward erase halts at. Authoritative and arrives before the paced
   *  replay; null until it lands. */
  keepLen?: number | null;
  reduced: boolean;
  /** Conversation language. `en` fills the re-speak at the word-stream rate
   *  (the retry replay is server-word-paced too), matching the bubble. */
  lang?: "zh" | "en";
}): string | null {
  const { retracting, vetoed, retryText, revealed, keepLen, reduced, lang } =
    args;
  const [display, setDisplay] = useState<string | null>(null);

  // Always-fresh retry buffer for the timers (they live across renders).
  const retryRef = useRef("");
  retryRef.current = retryText ?? "";

  // Always-fresh server-floor for the timers (they live across renders).
  const keepLenRef = useRef<number | null>(null);
  keepLenRef.current = keepLen ?? null;

  // Frozen at the retract rising edge: while NOT retracting they track the
  // live props, so the first retract render sees the values as of the veto.
  const vetoedRef = useRef("");
  const revealedRef = useRef("");
  if (!retracting) {
    vetoedRef.current = vetoed ?? "";
    revealedRef.current = revealed ?? "";
  }

  // Runs on the retracting edge; text (vetoed/revealed/retry) flows through refs.
  useEffect(() => {
    if (!retracting || reduced) {
      setDisplay(null);
      return;
    }
    const vetoedChars = [...vetoedRef.current];
    // NOTE: useRevealedText slices by UTF-16 units, so `revealed` may end
    // mid-surrogate; counting it in code points makes the first morph frame
    // show at most one full character more than was painted (it repairs the
    // split pair). Harmless, but the two hooks measure text differently.
    let pos = Math.min([...revealedRef.current].length, vetoedChars.length);
    setDisplay(vetoedChars.slice(0, pos).join(""));

    let timer: ReturnType<typeof setTimeout> | undefined;
    let erased = 0;
    const fillTick = (): void => {
      const retry = [...retryRef.current];
      if (pos >= retry.length) return; // caught up; waiting for more deltas
      const gap = retry.length - pos;
      // EN fills whole server-paced words per frame (matching the bubble's
      // useRevealedText EN rule); zh keeps the even 1/4-gap letter fill.
      const step =
        lang === "en"
          ? Math.min(gap, EN_MAX_REVEAL_PER_FRAME)
          : Math.min(MAX_REVEAL_PER_FRAME, Math.max(1, Math.ceil(gap / 4)));
      pos = Math.min(retry.length, pos + step);
      setDisplay(retry.slice(0, pos).join(""));
    };
    const shown = pos;
    let elapsed = 0;
    const shrinkStep = (): void => {
      // Either signal resolves the divergence: the server floor is
      // authoritative, and a streamed retry lets commonPrefixLen find it even
      // if the floor event is late or missing. The deadline is the third way
      // out — with no retry EVER (empty-recovery ladder, failed respeak,
      // interrupt) the erase must reach empty rather than crawl indefinitely.
      const known =
        keepLenRef.current !== null ||
        retryRef.current.length > 0 ||
        elapsed >= RETRACT_WAIT_MAX_MS;
      const matched = Math.max(
        keepLenRef.current ?? 0,
        commonPrefixLen(vetoedRef.current, retryRef.current),
      );
      if (pos > matched && pos > 0) {
        pos -= 1;
        erased += 1;
        setDisplay(vetoedChars.slice(0, pos).join(""));
      }
      if (known && (pos <= matched || pos === 0)) {
        // Divergence reached (or nothing left): hand off to the fill pump.
        timer = setInterval(fillTick, FILL_FRAME_MS);
        return;
      }
      // Known → the normal ramped (slow → fast) cadence, converging on a
      // divergence we can see. Unknown → the same cadence DECELERATED by
      // depth, so the erase keeps moving but saves the deep tail for a
      // divergence that has not arrived yet.
      const base = shrinkDelayMs(erased);
      const delay = known ? base : unknownDelayMs({ base, shown, pos });
      elapsed += delay;
      timer = setTimeout(shrinkStep, delay);
    };
    // Hold the on-screen prefix for a short beat, then WAIT for the retry to
    // tell us where to stop, and only then erase.
    //
    // The wait is the 2026-07-27 half. Between 2026-06-14 and the two-stage
    // rethink (2026-07-18) the erase deliberately did NOT wait: the retry
    // followed the veto within a few hundred ms, and holding through that gap
    // read as a dead pause. The rethink put a WHOLE MODEL CALL in between —
    // veto → cancelAndBackspace → rethink completion → respeak → first
    // divergent chunk → emitRetractFloor — so the floor now lands seconds
    // later, while the erase is chewing 40 chars/second toward empty. For any
    // ordinary line it reached empty first, every time: the prefix-preserving
    // morph this hook exists for could not fire, and every veto degraded into
    // wipe-then-retype.
    //
    // Waiting is safe again precisely BECAUSE of the rethink: the pause it
    // opened is covered by the thought indicator, so something is visibly
    // happening — which is exactly what was missing in 2026-06-14.
    const holdTimer = setTimeout(() => {
      timer = setTimeout(shrinkStep, shrinkDelayMs(0));
    }, RETRACT_HOLD_MS);
    return () => {
      clearTimeout(holdTimer);
      if (timer !== undefined) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    };
  }, [retracting, reduced, lang]);

  if (!retracting) return null;
  // Reduced motion: no per-character animation — but still hold the on-screen
  // prefix until the retry replay begins, then swap to it (rather than blank
  // the bubble through the silent-generation void).
  if (reduced)
    return retryText !== null && retryText.length > 0
      ? retryText
      : revealedRef.current;
  // First retract render, before the effect's initial setDisplay: show the
  // edge-frozen revealed prefix (what was already on screen — no flash).
  return display ?? revealedRef.current;
}
