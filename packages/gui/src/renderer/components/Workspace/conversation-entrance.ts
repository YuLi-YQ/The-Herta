/**
 * Session-switch stagger entrance (SPEC 2026-06-20-session-switch-transition).
 *
 * When the user switches between sessions the conversation panel used to swap
 * its contents instantly. Instead, the newly-loaded conversation's rows settle
 * in with a small staggered fade + upward drift. Per the adopted decision, ONLY
 * the rows visible in the viewport animate (the panel scrolls to the bottom on
 * switch, so that's the bottom suffix); rows scrolled out of view above just
 * snap to their final state. That keeps the cascade short regardless of how long
 * the thread is, and avoids spending animation on content nobody can see.
 *
 * Adopted feel (locked in the spec): duration 350ms, drift 12px, 70ms per-row
 * stagger, easeOutQuint `cubic-bezier(0.22, 1, 0.36, 1)`.
 */

/** Per-row entrance duration (ms). Matches the `conv-switch-in` keyframe. */
export const ENTRANCE_DURATION_MS = 350;
/** Delay added per successive visible row, so they cascade in (ms). */
export const ENTRANCE_STAGGER_MS = 70;
/** Upward drift the row travels as it fades in (px). The `conv-switch-in`
 *  keyframe in reference-ux.css hard-codes this value — keep them in sync. */
export const ENTRANCE_DRIFT_PX = 12;

export interface RowBounds {
  /** Row top, in the scroll container's content coordinates. */
  readonly top: number;
  /** Row bottom, in the scroll container's content coordinates. */
  readonly bottom: number;
}

/**
 * Decide which rows animate on a session switch and with what delay.
 *
 * A row animates iff it intersects the viewport at all; the visible rows
 * cascade top-to-bottom (the topmost visible row leads at delay 0). Returns a
 * map from row index → entrance delay in ms. Rows absent from the map must NOT
 * animate — they snap to their final state.
 *
 * Pure (no DOM) so the visibility + stagger logic is unit-testable; the caller
 * supplies measured bounds from `getBoundingClientRect`.
 */
export function planStaggerEntrance(args: {
  readonly rows: ReadonlyArray<RowBounds>;
  readonly viewport: { readonly top: number; readonly bottom: number };
  readonly staggerMs: number;
}): Map<number, number> {
  const { rows, viewport, staggerMs } = args;
  const plan = new Map<number, number>();
  let order = 0;
  rows.forEach((row, index) => {
    const visible = row.bottom > viewport.top && row.top < viewport.bottom;
    if (visible) {
      plan.set(index, order * staggerMs);
      order += 1;
    }
  });
  return plan;
}
