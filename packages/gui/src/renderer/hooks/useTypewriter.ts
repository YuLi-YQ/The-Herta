import { useLayoutEffect, useState } from "react";

const DEFAULT_CHAR_MS = 60;

/**
 * Reveal `target` one character at a time at a fixed, readable cadence while
 * `play` is true — a deliberate typewriter. (Unlike `useRevealedText`, which
 * paces bursty stream arrival and reaches the end of a short string in a few
 * frames, i.e. too fast to perceive.) When `play` is false or reduced-motion
 * is set, the full `target` is shown immediately.
 *
 * Returns the revealed prefix plus a `typing` flag (true while still
 * revealing), which the caller can use to show a caret.
 */
export function useTypewriter(
  target: string,
  opts: {
    readonly play: boolean;
    readonly reduced: boolean;
    readonly charMs?: number;
  },
): { readonly text: string; readonly typing: boolean } {
  const charMs = opts.charMs ?? DEFAULT_CHAR_MS;
  const { play, reduced } = opts;
  const [len, setLen] = useState(target.length);

  // LAYOUT effect, deliberately: `len` starts (and after a non-playing phase,
  // sits) at target.length, so on the render that flips `play` true a passive
  // effect would let the browser PAINT the full title for one frame before
  // resetting to 0 — a visible full-title flash right where the eye is
  // watching the reveal. Resetting before paint kills the flash.
  useLayoutEffect(() => {
    if (!play || reduced) {
      setLen(target.length);
      return;
    }
    setLen(0);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setLen(i);
      if (i >= target.length) window.clearInterval(id);
    }, charMs);
    return () => window.clearInterval(id);
  }, [play, reduced, charMs, target]);

  const text = target.slice(0, Math.min(len, target.length));
  const typing = play && !reduced && text.length < target.length;
  return { text, typing };
}
