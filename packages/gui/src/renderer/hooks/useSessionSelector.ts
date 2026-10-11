import { useRef, useSyncExternalStore } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import type { SessionSnapshotView } from "../store/session-store.js";

/**
 * Subscribe to a SLICE of the active-session snapshot.
 *
 * `useActiveSession` returns the whole snapshot, whose identity changes on
 * EVERY store emit — including every streaming delta — so any component using
 * it re-renders dozens of times per second during a reply. Consumers that need
 * only a field or two (the app root, the sidebar cards, the top bar) subscribe
 * through this hook instead and re-render only when the SELECTED value
 * actually changes.
 *
 * `select` runs against every emit; keep it cheap. The selection is compared
 * with `isEqual` (default `Object.is` — right for primitives and store-owned
 * references like `overlay`, which the store replaces only when that field
 * changes). Pass `shallowEqualObjects` when selecting a fresh object of
 * fields.
 */
export function useSessionSelector<T>(
  select: (s: SessionSnapshotView) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const { sessionStore } = useHertaBridge();
  // Inline selectors/equality change identity per render; route the latest
  // through refs so the store-driven getSnapshot always uses current logic.
  const selectRef = useRef(select);
  selectRef.current = select;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  // getSnapshot must return a STABLE reference until the selected value
  // actually changes, or useSyncExternalStore would re-render in a loop.
  const cache = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(sessionStore.subscribe, () => {
    const next = selectRef.current(sessionStore.getSnapshot());
    const cached = cache.current;
    if (cached !== null && isEqualRef.current(cached.value, next)) {
      return cached.value;
    }
    cache.current = { value: next };
    return next;
  });
}

/** Shallow key-by-key equality for object selections (one level deep). */
export function shallowEqualObjects<T extends Record<string, unknown>>(
  a: T,
  b: T,
): boolean {
  if (Object.is(a, b)) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}
