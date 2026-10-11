import { useSessionSelector } from "./useSessionSelector.js";

/** True when there is no active session AND the launch bootstrap has resolved
 *  (so the disconnected UI never flashes during startup). Single source of
 *  truth for the "disconnected" condition. Selector-based: consumers re-render
 *  on the connect/disconnect edge only, not on every streaming delta. */
export function useDisconnected(): boolean {
  return useSessionSelector((s) => s.bootstrapped && s.sessionId === null);
}
