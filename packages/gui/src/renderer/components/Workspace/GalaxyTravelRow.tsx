import { useEffect, useState } from "react";
import atelierOrbit from "../../assets/atelier-orbit.svg";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";

export interface GalaxyTravelRowProps {
  /** Quiet-hide exit fade (user 2026-07-31): keeps `is-shown` so the row
   *  fades in place — `is-exiting` wins the opacity — then Conversation
   *  unmounts it after IN_FLIGHT_EXIT_MS. */
  readonly exiting?: boolean;
}

export function GalaxyTravelRow(props: GalaxyTravelRowProps): JSX.Element {
  const t = useT();
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);
  return (
    <div
      className={`status-row${shown ? " is-shown" : ""}${
        props.exiting === true ? " is-exiting" : ""
      }`}
    >
      <div className="status-core">
        <img
          className="transfer-icon atelier-transfer-icon"
          src={atelierOrbit}
          alt=""
        />
        <span className="transfer-text is-shimmer">
          {t("workspace.sending")}
        </span>
      </div>
    </div>
  );
}
