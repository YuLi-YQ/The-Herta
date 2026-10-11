import { useEffect, useState } from "react";

/** Veil duration past the last snap-sized resize — covers the OS's ~250ms
 *  maximize/restore crossfade-zoom with a little settle margin. */
const SNAP_SETTLE_MS = 260;
/** Single-event viewport jump that counts as a snap (button/keyboard
 *  maximize, half-screen snap layouts). Interactive edge-drags resize a few
 *  px per event and must never trigger the veil. */
const SNAP_MIN_DELTA_PX = 120;

/**
 * True for a beat after the viewport JUMPS (maximize / restore / snap
 * layout): Windows animates those as a ~250ms crossfade-zoom between the
 * OLD and NEW window surfaces. Top/left-anchored content sits at the same
 * spot in both frames, but the BOTTOM-anchored composer and RIGHT-anchored
 * utility rail land at different viewport positions — mid-crossfade they
 * read as an obvious DOUBLE composer (user 2026-07-14). The app can't reach
 * the OS animation; instead `.is-window-snap` (reference-ux.css) veils the
 * edge-anchored surfaces for the beat so the crossfade blends two
 * near-identical frosted backgrounds.
 */
export function useWindowSnap(): boolean {
  const [snapping, setSnapping] = useState(false);
  useEffect(() => {
    let lastW = window.innerWidth;
    let lastH = window.innerHeight;
    let timer: number | null = null;
    const onResize = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const jump =
        Math.abs(w - lastW) >= SNAP_MIN_DELTA_PX ||
        Math.abs(h - lastH) >= SNAP_MIN_DELTA_PX;
      lastW = w;
      lastH = h;
      if (!jump) return;
      setSnapping(true);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setSnapping(false);
      }, SNAP_SETTLE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
  return snapping;
}
