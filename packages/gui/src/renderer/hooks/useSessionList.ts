import type { SessionMetadata } from "@herta/app-server";
import { useSyncExternalStore } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";

export function useSessionList(): readonly SessionMetadata[] {
  const { sessionListStore } = useHertaBridge();
  return useSyncExternalStore(
    sessionListStore.subscribe,
    sessionListStore.getSnapshot,
  );
}
