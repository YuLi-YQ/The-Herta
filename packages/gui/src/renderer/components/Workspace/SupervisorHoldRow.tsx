import { useEffect, useState } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";

/** Rotate to the second in-world line once the judgment outlasts this —
 *  on a long wait the static hint itself starts reading as frozen
 *  (2026-07-11 live-reveal-front-load spec, rider). */
export const HINT_ROTATE_MS = 6_000;

// Transient in-world status row shown while the supervisor model judges a
// candidate speech (between the supervisor.check start/end bus events) —
// the paced reveal HOLDS its tail during the verdict, and on a slow
// judgment the user otherwise stares at a frozen cursor with no
// explanation (bug 4, 2026-07-09). The Conversation debounces its
// appearance so quick verdicts never flash it. Reuses the GalaxyTravelRow
// shimmer shell, text only (like RecapCompactRow).
export function SupervisorHoldRow(): JSX.Element {
  const t = useT();
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced);
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);
  // Line rotation: mounted lifetime tracks the judgment (the Conversation
  // unmounts this row the instant the verdict lands), so a simple mount
  // timer is the wait clock.
  useEffect(() => {
    const id = window.setTimeout(() => setLongWait(true), HINT_ROTATE_MS);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className={`status-row${shown ? " is-shown" : ""}`}>
      <div className="status-core">
        <span className="transfer-text is-shimmer">
          {t(longWait ? "workspace.gammaStormLong" : "workspace.gammaStorm")}
        </span>
      </div>
    </div>
  );
}
