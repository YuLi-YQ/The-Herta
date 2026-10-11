import { type ReactNode, useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { RoundThreeWorkbench } from "./components/RoundThreeWorkbench.js";
import {
  ErrorWindowControls,
  WindowControls,
} from "./components/WindowControls.js";
import { HertaBridgeProvider } from "./context/HertaBridgeContext.js";
import { LocaleProvider, useT } from "./i18n/LocaleProvider.js";
import { en } from "./i18n/messages/en.js";
import { zh } from "./i18n/messages/zh.js";
import type { HertaBridge, Locale } from "./ipc/bridge-types.js";
import { journeyMarkAfterPaint } from "./lib/journey.js";
import { initTheme } from "./lib/theme.js";

/** Centered "Herta could not start" panel shared by the bootstrap-error
 *  and missing-bridge paths. */
function ErrorScreen(props: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="app app-error" data-testid="app-error">
      <div className="app-error-panel">{props.children}</div>
    </div>
  );
}

/** Fallback for a render-phase crash anywhere under the Workbench (audit
 *  2026-07-13 T2.2): the existing ErrorScreen styling plus a reload — the
 *  session record is on disk, so a reload fully recovers. Rendered inside
 *  LocaleProvider (the boundary wraps Workbench only), so useT is safe. */
function WorkbenchCrashScreen({
  error,
}: {
  readonly error: Error;
}): JSX.Element {
  const t = useT();
  return (
    <ErrorScreen>
      <h2>{t("app.crashTitle")}</h2>
      <p>
        <code>{error.message}</code>
      </p>
      <p>{t("app.crashBody")}</p>
      <button
        type="button"
        className="app-error-reload"
        onClick={() => window.location.reload()}
      >
        {t("app.crashReload")}
      </button>
    </ErrorScreen>
  );
}

export interface AppProps {
  /** Defaults to window.herta; tests inject a mock bridge. */
  readonly bridge?: HertaBridge;
}

export function App(props: AppProps = {}): JSX.Element {
  const bridge = props.bridge ?? window.herta;
  // R1 has no approved character art or opening audio. The desktop shell is
  // usable immediately; optional upstream openings remain source-only.

  // Seed from the OS (navigator) for the first paint, then reconcile with the
  // persisted value from main. The boot splash hides the workbench while this
  // resolves, so a seed→stored swap is never visible.
  const [locale, setLocale] = useState<Locale>("zh");
  useEffect(() => {
    if (bridge === undefined) return;
    let alive = true;
    void bridge.getLocale().then((l) => {
      if (alive) setLocale(l);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  // Appearance (night-mode slice 2): stamp <html data-theme> from the
  // persisted preference; the boot splash covers the resolve, like locale.
  useEffect(() => {
    if (bridge === undefined) return;
    void initTheme(bridge);
  }, [bridge]);

  // Remove the index.html cold-start splash (#boot-splash) once React has
  // painted: by then the opening overlay (or an error/ref screen) is covering,
  // so the body's cyan gradient it was hiding becomes the frosted .app backdrop
  // instead of a cold-start flash. useEffect (post-paint), not layout, so the
  // overlay is already on screen when it goes.
  useEffect(() => {
    document.getElementById("boot-splash")?.remove();
    journeyMarkAfterPaint("launch:app-painted");
  }, []);

  // Frameless-window drag strip (SPEC v0.3 §5.1.1). Full-width, sits
  // behind the card (z-index 0) so it only catches drags in the green
  // margin; the OS draws native min/max/close on top at the right.
  // Rendered in both reference and normal modes so the window is always
  // movable.
  const titleBar = <div className="titlebar-drag" aria-hidden="true" />;

  // The preload exposes window.herta; if it failed to load, bridge is
  // undefined. Render a diagnosable error screen rather than crashing in
  // the store constructor (which would leave a blank window).
  if (bridge === undefined) {
    const m = locale === "zh" ? zh : en;
    const bridgeParts = m["app.bridgeUnavailable"].split("{bridge}");
    return (
      <>
        {titleBar}
        <ErrorScreen>
          <h2>{m["app.cantStart"]}</h2>
          <p>
            {bridgeParts[0]}
            <code>window.herta</code>
            {bridgeParts[1] ?? ""}
          </p>
          <p>{m["app.bridgeUnavailableBody"]}</p>
        </ErrorScreen>
        {/* Last, like WindowControls below: its no-drag rect must come after
            the drag strip's. */}
        <ErrorWindowControls closeLabel={m["window.closeBtn"]} />
      </>
    );
  }

  return (
    <>
      {titleBar}
      <LocaleProvider
        locale={locale}
        // State only: the Language pane persists the choice itself, so a
        // failed write can snap the UI back and say so (UX review
        // 2026-09-22, item 17).
        onLocaleChange={setLocale}
      >
        <HertaBridgeProvider bridge={bridge}>
          {/* Render-crash containment (audit 2026-07-13 T2.2): a throw in
              any row/panel renderer used to unmount the whole root — blank
              window, restart-only. The fallback keeps the frame + reload. */}
          <ErrorBoundary
            label="workbench"
            fallback={(error) => <WorkbenchCrashScreen error={error} />}
          >
            <RoundThreeWorkbench />
          </ErrorBoundary>
          {/* Custom caption buttons — replaces the native titleBarOverlay
              (its tooltips could not be disabled and doubled on Windows;
              user 2026-07-06). Rendered LAST deliberately: Chromium applies
              app-region rects in document order, so this no-drag rect must
              come after every drag rect (.titlebar-drag AND .topbar inside
              Workbench) or a later drag re-covers the corner and the OS
              swallows the buttons' mouse events (the 2nd dead-buttons bug). */}
          <WindowControls />
        </HertaBridgeProvider>
      </LocaleProvider>
    </>
  );
}
