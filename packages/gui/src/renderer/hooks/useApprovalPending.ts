import { useSessionSelector } from "./useSessionSelector.js";

/**
 * True while the active session is awaiting a permission decision. Used to
 * guard session navigation: switching sessions or starting a new one tears
 * the active turn down (closeActiveSession → interrupt), which would strand
 * a pending gate. Selector-based, so consumers re-render only when the gate
 * opens/closes — not on every streaming delta.
 */
export function useApprovalPending(): boolean {
  return useSessionSelector((s) => s.overlay?.kind === "pending-permission");
}
