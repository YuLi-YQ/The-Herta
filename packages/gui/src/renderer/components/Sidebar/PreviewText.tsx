import { useEffect, useState } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";

/** Half of the cross-fade (out, then in). Keep in sync with the CSS opacity
 *  transition on `.session-item__preview`. */
const FADE_MS = 150;

/**
 * The sidebar card's message-preview text. When `text` changes — e.g. you
 * switch away from a session and its preview flips from this activation's first
 * message to the last message you sent — it cross-fades: fade the old out, swap,
 * fade the new in. First mount and reduced-motion render instantly (the row's
 * grid-grow provides the first-appearance animation).
 */
export function PreviewText(props: { readonly text: string }): JSX.Element {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(props.text);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (props.text === shown || reduced) {
      setShown(props.text);
      setFading(false);
      return;
    }
    // Fade the current text out, then swap + fade the new text in.
    setFading(true);
    const t = window.setTimeout(() => {
      setShown(props.text);
      setFading(false);
    }, FADE_MS);
    return () => window.clearTimeout(t);
  }, [props.text, shown, reduced]);

  return (
    <span className={`session-item__preview${fading ? " is-fading" : ""}`}>
      {shown}
    </span>
  );
}
