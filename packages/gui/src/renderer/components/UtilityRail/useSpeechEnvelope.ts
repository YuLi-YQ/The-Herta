import { useEffect, useMemo, useRef } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { measureRevealSpan } from "../../lib/reveal-perf.js";
import { subscribeRevealedSpeech } from "../../lib/reveal-source.js";
import {
  createSpeakableTracker,
  type SpeakableGrowthStep,
} from "./speakable-tracker.js";
import type { Kicks } from "./wave-engine.js";

/** Sentence-ending punctuation → a long breath (the sink also pauses). */
const HARD_PUNCT = new Set(["。", "！", "？", "…", "—"]);
/** Clause punctuation → a short breath. */
const SOFT_PUNCT = new Set(["，", "、", "；", "：", ",", ";", ":"]);
/** EN sentence enders → a long breath, but ONLY in an EN session — ASCII "."
 *  is far too common in zh prose (paths, versions: "src/main.ts", "0.2") to
 *  treat as a sentence break globally, so this is lang-gated. It mirrors the
 *  sink's EN_SENTENCE_PUNCT breath so the wave settles where the text pauses.
 *  (Clause marks , ; : already live in SOFT_PUNCT, so they work in both.) */
const EN_HARD_PUNCT = new Set([".", "!", "?"]);

export interface SpeechKicksSource {
  /** Return kicks accumulated since the last drain and reset. Called by
   *  the canvas loop once per frame. */
  drainKicks(): Kicks;
}

/**
 * Converts Herta's speech into per-character kick events for the wave
 * engine. Watches the SHARED reveal source (`reveal-source.ts` — the
 * scrubbed prefix StreamingReply actually paints, so the wave breathes
 * with the visible typewriter) plus `retryText` growth during a veto
 * retract (the paced replay buffers there; the shrink itself contributes
 * no kicks, so a veto reads as the wave quieting). Renderer-local only
 * (SPEC v0.3 §9.3 / D7); the future audio analyser (SPEC §6.2) feeds the
 * same Kicks shape.
 *
 * Fully imperative (perf 2026-08-25): both watches are subscriptions
 * feeding refs drained by AuraVisual's canvas loop — this hook never
 * re-renders its owner, where it previously held its own second
 * `useRevealedText` (a duplicate rAF loop re-rendering the aura card
 * every frame) and two FULL `scanSpeakable` scans per render. Growth now
 * derives from the appended suffix via `createSpeakableTracker`. Code
 * blocks / table rows still contribute no kicks: the wave rests while
 * Herta "pastes" rather than speaks.
 */
export function useSpeechEnvelope(): SpeechKicksSource {
  const { sessionStore } = useHertaBridge();
  const pending = useRef<{ count: number; punctuation: Kicks["punctuation"] }>({
    count: 0,
    punctuation: null,
  });

  useEffect(() => {
    const revealTracker = createSpeakableTracker();
    const retryTracker = createSpeakableTracker();
    const accumulate = (step: SpeakableGrowthStep): void => {
      // Shrinks / resets / partial-fence reclassification rebase the
      // tracker's own counter — never negative kicks.
      if (step.grown <= 0) return;
      pending.current.count += step.grown;
      const last = step.last ?? "";
      const lang = sessionStore.getSnapshot().lang;
      if (HARD_PUNCT.has(last) || (lang === "en" && EN_HARD_PUNCT.has(last)))
        pending.current.punctuation = "hard";
      else if (SOFT_PUNCT.has(last)) pending.current.punctuation = "soft";
    };
    const unsubReveal = subscribeRevealedSpeech((text) => {
      accumulate(
        measureRevealSpan(
          "envelope.scan",
          () => revealTracker.push(text ?? ""),
          (r) => r.scanned,
        ),
      );
    });
    // retryText grows per store delta (not per frame) — watch it there.
    let prevRetry = sessionStore.getSnapshot().retryText;
    const unsubStore = sessionStore.subscribe(() => {
      const retry = sessionStore.getSnapshot().retryText;
      if (retry === prevRetry) return;
      prevRetry = retry;
      accumulate(
        measureRevealSpan(
          "envelope.scan",
          () => retryTracker.push(retry ?? ""),
          (r) => r.scanned,
        ),
      );
    });
    return () => {
      unsubReveal();
      unsubStore();
    };
  }, [sessionStore]);

  return useMemo(
    () => ({
      drainKicks: (): Kicks => {
        const k: Kicks = {
          count: pending.current.count,
          punctuation: pending.current.punctuation,
        };
        pending.current.count = 0;
        pending.current.punctuation = null;
        return k;
      },
    }),
    [],
  );
}
