import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "../hooks/useReducedMotion.js";
import { useTypewriter } from "../hooks/useTypewriter.js";

/** Must match the `.title-fade-out` CSS animation duration. */
const FADE_MS = 220;

export interface TitleTextProps {
  /** The title to show (the real generated title, or the placeholder). */
  readonly text: string;
  /** Shown (fading out) during the fade phase before the title types in. */
  readonly placeholder: string;
  /** When true (a freshly generated title arrived), play the
   *  fade-out → typewriter reveal. Otherwise render `text` instantly. */
  readonly animate: boolean;
  /** Fired once when the title is fully shown — after the fade+typewriter
   *  when animating, or immediately when rendering instantly. Lets a caller
   *  (the sidebar card) sequence a second line in after the title. */
  readonly onRevealed?: () => void;
}

type Phase = "idle" | "fade" | "type";

/**
 * Renders a session title. When `animate` flips true, the placeholder fades
 * out, then the title types in character-by-character with a caret. Honors
 * reduced-motion (renders instantly). Disk-loaded titles (animate=false)
 * render instantly with no replay.
 */
export function TitleText(props: TitleTextProps): JSX.Element {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");

  // LAYOUT effect, deliberately (audit 2026-07-10): with a passive effect,
  // the commit where `animate` flips true PAINTED first — and at phase
  // "idle" this component renders the FULL final title, so every freshly
  // generated title flashed complete for a frame before vanishing into the
  // placeholder fade + typewriter. Pre-paint phase transition kills the
  // flash (the same guard useTypewriter documents for its own reset).
  useLayoutEffect(() => {
    if (!props.animate || reduced) {
      setPhase("idle");
      return;
    }
    setPhase("fade");
    const t = window.setTimeout(() => setPhase("type"), FADE_MS);
    return () => window.clearTimeout(t);
  }, [props.animate, reduced]);

  const typed = useTypewriter(props.text, { play: phase === "type", reduced });

  // Fire onRevealed exactly once per reveal cycle, when the title is fully
  // shown (idle = instant; type-done = animation finished).
  const onRevealedRef = useRef(props.onRevealed);
  onRevealedRef.current = props.onRevealed;
  const firedRef = useRef(false);
  useEffect(() => {
    // A fresh animation re-arms the one-shot guard.
    if (props.animate && !reduced) firedRef.current = false;
  }, [props.animate, reduced]);
  useEffect(() => {
    // "idle" only counts as revealed in instant mode; when we're about to
    // animate, phase is briefly "idle" before the fade starts — don't fire yet.
    const instant = !props.animate || reduced;
    const revealed =
      (instant && phase === "idle") || (phase === "type" && !typed.typing);
    if (revealed && !firedRef.current) {
      firedRef.current = true;
      onRevealedRef.current?.();
    }
  }, [phase, typed.typing, props.animate, reduced]);

  // Always a single inline span so callers using a flex container (the header)
  // see exactly one child (no gap injected between text and caret).
  if (phase === "fade") {
    return (
      <span className="title-text title-fade-out">{props.placeholder}</span>
    );
  }
  if (phase === "type") {
    return (
      <span className="title-text">
        {typed.text}
        {typed.typing && (
          <span className="title-caret" aria-hidden="true">
            ▍
          </span>
        )}
      </span>
    );
  }
  return <span className="title-text">{props.text}</span>;
}
