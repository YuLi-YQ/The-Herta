/** The window surface `hideToTray` needs: a BrowserWindow, or a test fake. */
export interface HideableWindow {
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  once(event: "leave-full-screen", listener: () => void): unknown;
  hide(): void;
  isDestroyed(): boolean;
}

/**
 * Hide the window to the tray (close-to-tray).
 *
 * On macOS a full-screen window owns a Space of its own, and hiding it there
 * left that Space black and empty: the user was stranded on a black screen
 * until they swiped away (platform review 2026-09-23). So a full-screen window
 * leaves full screen first and hides once the animation has ended. Windows and
 * Linux have no such Space; there the window hides at once.
 */
export function hideToTray(
  win: HideableWindow,
  platform: NodeJS.Platform,
): void {
  if (platform === "darwin" && win.isFullScreen()) {
    win.once("leave-full-screen", () => {
      if (!win.isDestroyed()) win.hide();
    });
    win.setFullScreen(false);
    return;
  }
  win.hide();
}
