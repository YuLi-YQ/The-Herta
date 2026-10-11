import { useEffect, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";

/**
 * Whether the window is in full screen — seeded from main on mount (a
 * reloaded renderer in a full-screen window), then kept by main's
 * enter/leave events. False when the bridge has no such surface (fakes, the
 * website demo).
 */
export function useWindowFullScreen(): boolean {
  const { bridge } = useHertaBridge();
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    let alive = true;
    // An event that lands first is newer than the seed: the seed then yields.
    let heard = false;
    bridge.windowIsFullScreen?.().then(
      (v) => {
        if (alive && !heard) setFullScreen(v);
      },
      () => undefined,
    );
    const off = bridge.onWindowFullScreen?.((v) => {
      heard = true;
      setFullScreen(v);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge]);
  return fullScreen;
}
