import { useSyncExternalStore } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import type {
  SessionSnapshotView,
  SessionStatus,
} from "../store/session-store.js";

export type ActiveSessionStatus = SessionStatus;
export type ActiveSessionView = SessionSnapshotView;

export function useActiveSession(): ActiveSessionView {
  const { sessionStore } = useHertaBridge();
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
}

/**
 * The active session's interaction language, as a SELECTOR (returns just the
 * primitive), so message bubbles can localize the 板砖→Brick display without
 * re-rendering on every streaming delta — `useSyncExternalStore` bails out
 * unless `lang` itself changes (Object.is), which it does only on activation.
 */
export function useSessionLang(): "zh" | "en" {
  const { sessionStore } = useHertaBridge();
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getSnapshot().lang,
  );
}
