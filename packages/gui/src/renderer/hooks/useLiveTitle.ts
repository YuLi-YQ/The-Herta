import { useSyncExternalStore } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import type { LiveTitle } from "../store/session-list-store.js";

/**
 * The session whose title most recently arrived via a live `session:title`
 * event, or null. A sidebar entry uses this to decide whether to type its
 * title in (live) or render it instantly (disk-loaded).
 */
export function useLiveTitle(): LiveTitle | null {
  const { sessionListStore } = useHertaBridge();
  return useSyncExternalStore(
    sessionListStore.subscribe,
    sessionListStore.getLiveTitleSnapshot,
  );
}
