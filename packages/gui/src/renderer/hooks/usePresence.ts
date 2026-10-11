import { useEffect, useRef, useState } from "react";

/**
 * Presence controller for enter/exit-animated conditional UI.
 *
 * CSS can't animate an unmount, and a mount lands at its final state unless
 * something arms the transition one frame later — so bare `{cond && <El/>}`
 * elements pop in and out (user 2026-07-11, the armed switch badge). This
 * hook is the shared version of the confirm-delete pill's ad-hoc mechanics:
 *
 *   - `mounted` — render gate. Turns true immediately on activation and
 *     stays true through the exit, dropping `exitMs` after deactivation.
 *     Set `exitMs` >= the exit transition's duration.
 *   - `open` — the CSS class driver. Flips true one FRAME after mount (the
 *     mount frame renders in the collapsed/hidden base state, so the
 *     entrance transition has a from-state to leave) and false the moment
 *     `active` drops, starting the exit while the element is still mounted.
 *
 * Re-activation mid-exit cancels the pending unmount and re-opens in place.
 * Under reduced motion the CSS side disables its transitions, so the
 * one-frame arming delay is invisible there.
 */
export function usePresence(
  active: boolean,
  exitMs: number,
): { mounted: boolean; open: boolean } {
  const [mounted, setMounted] = useState(active);
  const [open, setOpen] = useState(false);
  const mountedRef = useRef(active);
  const unmountTimer = useRef<number | null>(null);
  useEffect(() => {
    if (active) {
      if (unmountTimer.current !== null) {
        window.clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
      mountedRef.current = true;
      setMounted(true);
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
    setOpen(false);
    if (!mountedRef.current) return;
    unmountTimer.current = window.setTimeout(() => {
      unmountTimer.current = null;
      mountedRef.current = false;
      setMounted(false);
    }, exitMs);
    return () => {
      if (unmountTimer.current !== null) {
        window.clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
    };
  }, [active, exitMs]);
  return { mounted, open };
}
