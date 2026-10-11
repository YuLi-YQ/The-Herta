import type { ApprovalOverlayState } from "@herta/app-server";
import { useActiveSession } from "./useActiveSession.js";

export function useOverlay(): ApprovalOverlayState | null {
  return useActiveSession().overlay;
}
