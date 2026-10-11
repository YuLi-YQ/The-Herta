/**
 * Is a bubble morph in flight right now?
 *
 * A renderer-global counter rather than React state, because the only consumer
 * reads it from inside a rAF loop (AuraVisual's frame governor), where a
 * subscription would buy nothing and a re-render per flight would cost more
 * than it saves. The flights own the truth: `useRiseAnimation` opens one on
 * start and closes it on settle/cancel.
 *
 * Why anything cares, and NOT the reason first assumed. The suspicion was that
 * the aura burns full frame rate during a send and could be suppressed to free
 * budget for the flight. Measured on the built renderer at 6× throttle, that
 * is not what happens: a send changes the aura's state, so it asks for full
 * rate, and the congested main thread hands it 12–17 rAF callbacks per second
 * instead — a visible stutter, in the same window the eye is following a bubble
 * across the screen. Pinning it to the idle governor's timer cadence for the
 * flight measured 28–32fps steady, because a timer keeps its slot where a rAF
 * request competes for one (2026-07-30).
 *
 * So this buys smoothness, not cost: it draws slightly MORE over the window
 * than the starved version managed. It is affordable because the wave is
 * peripheral and its uniform lerps are dt-based — they settle on the same wall
 * clock whatever the sampling rate — and because ~30fps is the cadence its own
 * governor already treats as good enough at rest.
 */
let flights = 0;

/** Open a flight. Balanced by exactly one {@link endMorphFlight}. */
export function beginMorphFlight(): void {
  flights += 1;
}

/** Close a flight. Clamped at zero so an unbalanced call cannot wedge the
 *  counter negative and permanently convince readers nothing is flying. */
export function endMorphFlight(): void {
  flights = Math.max(0, flights - 1);
}

export function morphFlightActive(): boolean {
  return flights > 0;
}

/** Test-only reset, so one test's stray flight cannot leak into the next. */
export function resetMorphFlights(): void {
  flights = 0;
}
