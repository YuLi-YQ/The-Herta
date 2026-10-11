import type { ApprovalOverlayState } from "@herta/app-server";

/**
 * Overlay fixtures for visual sanity checks. Slice 3's live shell
 * does not surface a pending overlay (no permission requests
 * happen with fixture-only data); these fixtures exist so future
 * tests / component stories can render the pending state.
 */
export const mockIdleOverlay: ApprovalOverlayState = { kind: "idle" };

// Pending fixtures intentionally omitted in Slice 3 — they require
// PendingPermissionApproval / PendingCommandApproval shapes that
// Slice 5 (approval overlay UI) will exercise. Adding them now
// without a renderer that consumes them would be dead code.
