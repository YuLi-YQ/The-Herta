import { useEffect, useRef, useState } from "react";
import { PRODUCT_PROFILE } from "../../../shared/product-profile.js";
import atelierMark from "../../assets/atelier-mark.svg";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";

/** Exit-animation duration; keep in sync with the `connectOut` keyframe. */
export const CONNECT_EXIT_MS = 200;

export interface ConnectStationProps {
  /** True while the session is disconnected. When it flips false, the button
   *  plays its leave animation then unmounts (the "fade-through" reconnect). */
  readonly show: boolean;
  /** When the button arrives directly after a disconnect morph, the flying
   *  clone already played the entrance — replaying `connectIn` would flash a
   *  dip right after the clone lands. Set true in that case to skip the
   *  entrance keyframe so the hand-off is seamless. The exit (`connectOut`)
   *  fade is unaffected. Defaults false (keep the entrance for the no-morph
   *  cases: launch-disconnected, reduced motion). */
  readonly instant?: boolean;
  /** Called on click with the live button rect so the parent can start the
   *  reconnect morph. Fires alongside createSession. */
  readonly onConnect?: (rect: DOMRect) => void;
  /** Called when createSession rejects or resolves null: the parent cancels
   *  the reconnect morph so the landed clone doesn't sit as a dead gray
   *  circle (with the connect button withheld) until the 4s guard timer. */
  readonly onConnectFailed?: () => void;
  /** When the reconnect morph takes over, the flying clone REPLACES this button,
   *  so it must vanish instantly — skip the `connectOut` leave animation (which
   *  would otherwise leave a ghost capsule fading beside the clone). */
  readonly instantExit?: boolean;
}

/** The centered "connect" affordance shown while disconnected. Clicking it
 *  starts a new session (the disconnected state then clears via reset).
 *  Manages its own enter/leave animation: mounts when `show` becomes true,
 *  stays mounted for CONNECT_EXIT_MS after `show` flips false so the exit
 *  animation can play, then unmounts. */
export function ConnectStation(props: ConnectStationProps): JSX.Element | null {
  const t = useT();
  const { bridge } = useHertaBridge();
  const btnRef = useRef<HTMLButtonElement>(null);
  // Double-click guard: two rapid clicks created two sessions (racing
  // opening voices + an orphaned empty card). Latched until the IPC settles.
  const connecting = useRef(false);
  const [createFailed, setCreateFailed] = useState(false);
  const [mounted, setMounted] = useState(props.show);
  useEffect(() => {
    if (props.show) {
      setMounted(true);
      return undefined;
    }
    // A failure belongs to the attempt it answered. Once the station hides
    // (a session opened, by this button or any other path) it is over; the
    // component stays mounted, and a later, unrelated disconnect used to
    // show "connect failed" for an attempt nobody made (UX review
    // 2026-09-22, item 22).
    setCreateFailed(false);
    if (props.instantExit) {
      setMounted(false);
      return undefined;
    }
    const t = window.setTimeout(() => setMounted(false), CONNECT_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [props.show, props.instantExit]);
  // Replaced by the reconnect morph clone — vanish this frame, no leave anim.
  if (props.instantExit && !props.show) return null;
  if (!mounted) return null;
  // `is-instant` skips the `connectIn` entrance (post-morph hand-off). Only
  // meaningful while entering (`show` true); the exit class always wins below.
  const instantClass = props.instant && props.show ? " is-instant" : "";
  return (
    <div
      className={`connect-station-wrap${props.show ? "" : " is-leaving"}${instantClass}`}
    >
      <div className="atelier-connect-heading">
        <img src={atelierMark} alt="" />
        <h1>{PRODUCT_PROFILE.name}</h1>
        <p>{t("baseline.offline")}</p>
      </div>
      <button
        ref={btnRef}
        type="button"
        className="connect-station"
        onClick={() => {
          if (connecting.current) return;
          connecting.current = true;
          if (btnRef.current)
            props.onConnect?.(btnRef.current.getBoundingClientRect());
          setCreateFailed(false);
          void bridge.createSession({}).then(
            (s) => {
              connecting.current = false;
              // Main returns null when no host is available — the session did
              // NOT open; give the morph back its connect button.
              if (s === null) {
                setCreateFailed(true);
                props.onConnectFailed?.();
              }
            },
            () => {
              connecting.current = false;
              setCreateFailed(true);
              props.onConnectFailed?.();
            },
          );
        }}
      >
        <span className="connect-station-label">{t("connect.button")}</span>
      </button>
      <p className="atelier-connect-note">{t("baseline.providerPending")}</p>
      {/* A failed create used to restore the button and say nothing (audit
          BL20) — the click read as "didn't register", so the user clicked
          again into the same failure. Narrow trigger (a transient
          ENOSPC/EACCES at create time; bootstrap failures already surface via
          ErrorScreen), but silence is the wrong answer to any of them. */}
      {createFailed && (
        <p className="connect-station-error" role="alert">
          {t("connect.failed")}
        </p>
      )}
    </div>
  );
}
