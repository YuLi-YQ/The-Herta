import { useEffect, useMemo, useRef, useState } from "react";
import { makeT } from "../../i18n/LocaleProvider.js";

export interface PendingActivityProps {
  readonly turnStartedAt: number | null;
  /** Actual 板砖 backend start (Date.now at backend-layer turn.started);
   *  preferred over turnStartedAt as the timer anchor. */
  readonly backendStartedAt: number | null;
  /** Active session interaction language: the coprocessor chip + "Working…"
   *  status follow the SESSION, not the UI locale (GUI record-label parity,
   *  ADR 0018 / ADR 0015 §4). */
  readonly lang: "zh" | "en";
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${`${s}`.padStart(2, "0")}`;
}

/** Immediate "差分协处理器 处理中…" placeholder shown while the backend turn is
 *  running but has not yet produced its first record block. Replaced by the
 *  real ActivityBlock once a backend block lands. */
export function PendingActivity(props: PendingActivityProps): JSX.Element {
  const t = useMemo(() => makeT(props.lang), [props.lang]);
  const startRef = useRef<number | null>(
    props.backendStartedAt ?? props.turnStartedAt,
  );
  const [, tick] = useState(0);
  useEffect(() => {
    const preferred = props.backendStartedAt ?? props.turnStartedAt;
    if (startRef.current === null && preferred !== null) {
      startRef.current = preferred;
    }
    const id = window.setInterval(() => tick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [props.backendStartedAt, props.turnStartedAt]);
  const start =
    startRef.current ?? props.backendStartedAt ?? props.turnStartedAt;
  const durationText =
    start === null ? null : formatDuration(Date.now() - start);
  return (
    <div
      className="activity-line-group is-active is-pending"
      data-testid="pending-activity"
    >
      <div className="activity-line">
        <span className="activity-line__led is-pulsing" aria-hidden="true" />
        <span className="activity-line__label">
          {t("record.chip.coprocessor")}
        </span>
        <span className="activity-line__summary is-shimmer">
          {t("workspace.processing")}
        </span>
        {durationText !== null && (
          <span className="activity-line__duration">{durationText}</span>
        )}
      </div>
    </div>
  );
}
