import { describe, expect, it } from "vitest";
import { type HideableWindow, hideToTray } from "./hide-to-tray.js";

function fakeWindow(fullScreen: boolean) {
  const log: string[] = [];
  let onLeave: (() => void) | null = null;
  let state = fullScreen;
  const win: HideableWindow = {
    isFullScreen: () => state,
    setFullScreen: (flag) => {
      log.push(`setFullScreen(${flag})`);
      state = flag;
    },
    once: (_event, listener) => {
      onLeave = listener;
    },
    hide: () => {
      log.push("hide");
    },
    isDestroyed: () => false,
  };
  return { win, log, leave: () => onLeave?.() };
}

describe("hideToTray (platform review 2026-09-23)", () => {
  it("macOS full screen: leaves full screen FIRST and hides once that has ended — no black Space left behind", () => {
    const { win, log, leave } = fakeWindow(true);
    hideToTray(win, "darwin");
    expect(log).toEqual(["setFullScreen(false)"]);
    leave();
    expect(log).toEqual(["setFullScreen(false)", "hide"]);
  });

  it("a windowed Mac window, and every Windows / Linux window, hides at once", () => {
    for (const [platform, full] of [
      ["darwin", false],
      ["win32", true],
      ["linux", true],
    ] as const) {
      const { win, log } = fakeWindow(full);
      hideToTray(win, platform);
      expect(log, platform).toEqual(["hide"]);
    }
  });
});
