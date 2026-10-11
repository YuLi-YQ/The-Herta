/**
 * One shared coarse wall clock (perf 2026-08-25). Adaptive timestamp labels
 * ("just now" → "N min ago") need SOMETHING to advance them while a session
 * sits open; that used to be a `useNow` state hook on Conversation, which
 * re-rendered the whole component — and rebuilt every mounted row element —
 * every 30s for what is at most a handful of changed labels. The clock is
 * now a module-level store the timestamp leafs subscribe to directly
 * (`useSyncExternalStore` in BubbleTime): a tick re-derives each label as a
 * string snapshot, and React re-renders only the leafs whose label actually
 * changed. Conversation no longer reads the time at all.
 *
 * One interval serves every subscriber, and runs only while at least one
 * exists — a window with no timestamped rows keeps no timer.
 */

/** 30s granularity is plenty: the finest label granularity is one minute,
 *  and the labels are hover-only. */
export const NOW_TICK_MS = 30_000;

const listeners = new Set<() => void>();
let nowMs = Date.now();
let timer: number | null = null;

/** The last tick's wall time (epoch ms). Coarse by design — a snapshot up to
 *  {@link NOW_TICK_MS} stale renders the same label a fresh read would in all
 *  but the final seconds before a minute boundary. Deliberately NOT a live
 *  `Date.now()`: the `useSyncExternalStore` contract wants snapshots that
 *  only change when the store has notified. */
export function getNowMs(): number {
  return nowMs;
}

export function subscribeNow(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Fresh baseline with the first subscriber — the module may have loaded
    // long before the first timestamped row mounted.
    nowMs = Date.now();
    timer = window.setInterval(() => {
      nowMs = Date.now();
      for (const l of listeners) l();
    }, NOW_TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}
