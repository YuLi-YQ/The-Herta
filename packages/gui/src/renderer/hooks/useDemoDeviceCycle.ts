import { useEffect, useState } from "react";
import type { BanzhuanDeviceState } from "./useDeviceState.js";
import { useReducedMotion } from "./useReducedMotion.js";

/**
 * The lifecycle loop the Settings demo card walks through — mirrors the
 * `reference_UX_design/device-states.html` cadence so the eased color
 * cross-fades, the green success hold, and the red double-flash are all visible.
 * Each entry is `[state, dwellMs]`.
 */
const CYCLE: ReadonlyArray<readonly [BanzhuanDeviceState, number]> = [
  ["idle", 1600],
  ["delegated", 2600],
  ["waitingApproval", 2600],
  ["delegated", 1800],
  ["succeeded", 2200],
  ["idle", 1600],
  ["delegated", 2400],
  ["failed", 2600],
  ["idle", 1800],
];

/**
 * Drive the Settings lifecycle demo: step through {@link CYCLE} on a timer,
 * returning the current state. `paused` (hover) holds on the current state.
 * Honors reduced-motion — under it the cycle never advances and the card holds
 * `idle` (no flashing); the static legend conveys the states instead. The timer
 * is cleared on unmount.
 */
export function useDemoDeviceCycle(paused: boolean): BanzhuanDeviceState {
  const reduced = useReducedMotion();
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (paused || reduced) return; // hold on the current state
    const dwell = CYCLE[idx]?.[1] ?? 1800;
    const timer = window.setTimeout(() => {
      setIdx((i) => (i + 1) % CYCLE.length);
    }, dwell);
    return () => window.clearTimeout(timer);
  }, [idx, paused, reduced]);

  if (reduced) return "idle";
  return CYCLE[idx]?.[0] ?? "idle";
}
