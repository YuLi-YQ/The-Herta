import { useLayoutEffect, useRef, useState } from "react";

/** Must match the swap-in/swap-out CSS animation duration. */
const SWAP_MS = 240;

export interface SwapTextProps {
  readonly text: string;
  /** Reduced motion: replace instantly, never mount a leaving span. */
  readonly reduced: boolean;
  /** When set, the current line shimmers — used for the live 板砖 working
   *  step so it reads as active even between step changes (the LED pulse
   *  alone wasn't enough). Continuous with the pending 处理中… shimmer. */
  readonly shimmer?: boolean;
}

/**
 * One-line text that swaps in place: on a text change the old line slides
 * up-and-out while the new slides in from below, inside a fixed-height
 * inline container so the row never reflows (spec 2026-06-12 §6.2 — the
 * 板砖 live status line's current step).
 */
export function SwapText(props: SwapTextProps): JSX.Element {
  const { text, reduced, shimmer = false } = props;
  const [leaving, setLeaving] = useState<string | null>(null);
  const prevRef = useRef(text);

  // LAYOUT effect, deliberately (audit 2026-07-10): with a passive effect,
  // the commit where `text` changes PAINTED first — the fresh keyed
  // `swap-text__in` node at its settled state (no is-entering) and the old
  // text already unmounted with no `swap-text__out` yet — so every swap
  // previewed its end-state for one frame before the slide/fade replayed.
  // Setting `leaving` before paint puts the entering class and the leaving
  // span in the first painted frame. (Same hazard class as useTypewriter's
  // documented pre-paint guard.)
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = text;
    if (reduced) {
      // A reduced flip mid-swap must also clear any in-flight leaving state.
      setLeaving(null);
      return;
    }
    if (text === prev) return;
    setLeaving(prev);
    const t = window.setTimeout(() => setLeaving(null), SWAP_MS);
    return () => window.clearTimeout(t);
  }, [text, reduced]);

  return (
    <span className="swap-text">
      <span
        key={text}
        className={`swap-text__in${leaving !== null ? " is-entering" : ""}${
          shimmer ? " is-shimmer" : ""
        }`}
      >
        {text}
      </span>
      {leaving !== null && (
        <span className="swap-text__out" aria-hidden="true">
          {leaving}
        </span>
      )}
    </span>
  );
}
