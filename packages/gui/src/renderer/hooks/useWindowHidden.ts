import { useEffect, useState } from "react";

/**
 * Tracks page visibility: true while the window is hidden — minimized,
 * tray'd (win.hide()), or fully occluded. Drives the `.is-window-hidden`
 * ambience pause (reference-ux.css, 2026-07-11): Chromium's background
 * throttling suspends rAF and timers in hidden windows but NOT
 * compositor-driven CSS animations, and close-to-tray keeps this app alive
 * for hours — the device aura/ring loops kept the GPU warm from the tray.
 */
export function useWindowHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => document.visibilityState === "hidden",
  );
  useEffect(() => {
    const onChange = (): void => {
      setHidden(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}
