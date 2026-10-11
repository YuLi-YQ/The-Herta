import { useEffect, useState } from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import { useT } from "../i18n/LocaleProvider.js";

const MinimizeIcon = (): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
    <path d="M1 5.5h9" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

const MaximizeIcon = (): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
    <rect
      x="1"
      y="1"
      width="9"
      height="9"
      rx="1.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
    />
  </svg>
);

const RestoreIcon = (): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
    <rect
      x="1"
      y="3"
      width="7"
      height="7"
      rx="1.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
    />
    <path
      d="M3.5 3V2.4A1.4 1.4 0 0 1 4.9 1H8.6A1.4 1.4 0 0 1 10 2.4V6.1a1.4 1.4 0 0 1-1.4 1.4H8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
    />
  </svg>
);

const CloseIcon = (): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
    <path
      d="M1.5 1.5l8 8M9.5 1.5l-8 8"
      stroke="currentColor"
      strokeWidth="1.1"
    />
  </svg>
);

/**
 * The caption's close button for the one screen that has no bridge: the
 * preload failed, so there is no IPC to minimize or maximize with, and the
 * frameless window on Windows and Linux had no way to close at all but Alt+F4
 * or the taskbar (platform review 2026-09-23). `window.close()` needs no
 * bridge; Electron closes the window at once, skipping close-to-tray, which
 * is right for an app that cannot run. A Mac keeps its native traffic lights
 * and needs nothing here.
 */
export function ErrorWindowControls(props: {
  readonly closeLabel: string;
}): JSX.Element | null {
  if (typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent))
    return null;
  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__btn is-close"
        aria-label={props.closeLabel}
        onClick={() => window.close()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/**
 * Custom caption buttons (user 2026-07-06): the native titleBarOverlay was
 * dropped because its Chromium-drawn buttons show hover tooltips that
 * cannot be disabled — doubled on Windows. These carry aria-labels for
 * assistive tech but deliberately NO title attributes, so nothing pops on
 * hover. Close routes through win.close() in main, so the close-to-tray
 * setting behaves exactly as before. Hidden on macOS (native traffic
 * lights remain there).
 */
export function WindowControls(): JSX.Element | null {
  const t = useT();
  const { bridge } = useHertaBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    // Seed the max/restore glyph on mount (a renderer reload while
    // maximized would otherwise show the wrong glyph until the next toggle).
    bridge.windowIsMaximized().then(
      (v) => {
        if (alive) setMaximized(v);
      },
      () => undefined,
    );
    const unsubscribe = bridge.onWindowMaximized((v) => setMaximized(v));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  if (bridge.platform === "darwin") return null;

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__btn"
        aria-label={t("window.minimize")}
        onClick={() => bridge.windowMinimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        className="window-controls__btn"
        aria-label={maximized ? t("window.restore") : t("window.maximize")}
        onClick={() => bridge.windowToggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        type="button"
        className="window-controls__btn is-close"
        aria-label={t("window.closeBtn")}
        onClick={() => bridge.windowClose()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
