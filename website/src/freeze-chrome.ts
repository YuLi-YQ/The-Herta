/**
 * Demo-freeze for renderer chrome (user decision 2026-07-06): visitors get
 * hover feedback but NO response from controls that would derail the scripted
 * demo — the search + new-session topbar icons, the Settings button, and the
 * device card's ⋯ menu. The sidebar toggle (first topbar icon) stays live.
 *
 * Works WITHOUT renderer modifications: React 18 delegates events at #root,
 * so a capture-phase listener on `document` runs first; stopPropagation there
 * means React's onClick never fires. Keyboard activation (Enter/Space on a
 * focused button) dispatches a real `click` too, so it is caught as well.
 * The demo bridge stays the authority regardless — createSession is
 * idempotent and deleteSession/openSession reject what the UI shouldn't
 * reach — this layer just keeps the chrome from *appearing* broken.
 */
const FROZEN_SELECTORS = [".sidebar-settings", ".card-menu-button"];

export function freezeDemoChrome(): void {
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      for (const sel of FROZEN_SELECTORS) {
        if (target.closest(sel) !== null) {
          e.stopPropagation();
          e.preventDefault();
          return;
        }
      }
      // Topbar icons by position (aria-labels are localized): 0 = sidebar
      // toggle (allowed), 1 = search, 2 = new session (both frozen).
      const icon = target.closest(".topbar .sidebar-header-icon");
      if (icon !== null) {
        const all = Array.from(
          document.querySelectorAll(".topbar .sidebar-header-icon"),
        );
        if (all.indexOf(icon) > 0) {
          e.stopPropagation();
          e.preventDefault();
        }
      }
    },
    { capture: true },
  );
}
