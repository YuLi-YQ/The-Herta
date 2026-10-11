import type { WorkspaceTrustState } from "@herta/app-server";
import type { WorkspaceTrust } from "@herta/core";
import { useRef } from "react";
import atelierMark from "../../assets/atelier-mark.svg";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import {
  type BanzhuanDeviceState,
  useDeviceState,
} from "../../hooks/useDeviceState.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { CardMenu } from "./CardMenu.js";

/** Retained for the upstream scene tests; R1 never starts that scene. */
export const SCENE_PATIENCE_MS = 30_000;

const STATE_KEY: Record<BanzhuanDeviceState, MessageKey> = {
  idle: "device.state.idle",
  delegated: "device.state.working",
  // Slice 5: the fine working states get their own labels; visually they
  // share the delegated blue halo (reference-ux.css groups the selectors) —
  // the split is in the label, not a new palette.
  reading: "device.state.reading",
  writing: "device.state.writing",
  runningCommand: "device.state.runningCommand",
  waitingApproval: "device.state.awaitingApproval",
  verifying: "device.state.verifying",
  succeeded: "device.state.done",
  failed: "device.state.error",
};

export function DeviceCard(): JSX.Element {
  const t = useT();
  const state = useDeviceState();
  // Select only the three snapshot fields this card reads, shallow-compared, so
  // streaming deltas (which don't touch these) don't re-render the device card.
  const snap = useSessionSelector(
    (s) => ({
      sessionId: s.sessionId,
      backendWorkspace: s.backendWorkspace,
      backendWorkspaceIsDefault: s.backendWorkspaceIsDefault,
    }),
    shallowEqualObjects,
  );
  const { bridge } = useHertaBridge();
  // A workspace error belongs to the session it happened in — don't resurface
  // a stale one in the next session's menu. (This hand-written reset is what
  // `useSessionScoped` generalizes; migrated 2026-07-24.)
  const [wsError, setWsError] = useSessionScoped<string | null>(null);
  // In-flight guard: rapid re-clicks queued a second OS folder dialog.
  const picking = useRef(false);
  const handleSet = async () => {
    if (snap.sessionId === null) return; // no session → nothing to set; don't open the dialog
    if (picking.current) return;
    picking.current = true;
    try {
      const picked = await bridge.pickWorkspace();
      if (picked !== null) {
        const res = await bridge.setWorkspace(snap.sessionId, picked);
        if (!res.ok) setWsError(res.message ?? t("card.workspaceSetError"));
        else setWsError(null);
      }
    } finally {
      picking.current = false;
    }
  };
  // Project command allow rules (ADR 0030). The DATA lives here — CardMenu is
  // presentational (its own tests render it with no bridge provider) — and is
  // refreshed on every menu OPEN so a rule granted mid-commission appears
  // without a remount. `null` means "this bridge has no rule surface" (fakes /
  // the website demo): the menu then omits the section entirely.
  const rulesSupported = bridge.listCommandRules !== undefined;
  const [rules, setRules] = useSessionScoped<readonly string[]>([]);
  const refreshRules = (): void => {
    if (!rulesSupported) return;
    void bridge.listCommandRules?.().then(
      (r) => setRules(r),
      () => {
        /* keep the last list — best-effort chrome */
      },
    );
  };
  const handleRemoveRule = (display: string): void => {
    void bridge.removeCommandRule?.(display).then(
      (ok) => {
        if (ok) setRules((prev) => prev.filter((r) => r !== display));
      },
      () => {
        /* row stays — nothing was deleted */
      },
    );
  };
  // Workspace trust (ADR 0064): same ownership as the rules — the data lives
  // here, refreshed on every menu open, and the row is omitted when the
  // bridge has no surface for it.
  const trustSupported = bridge.getWorkspaceTrust !== undefined;
  const [trust, setTrust] = useSessionScoped<WorkspaceTrustState | null>(null);
  const refreshTrust = (): void => {
    if (!trustSupported) return;
    void bridge.getWorkspaceTrust?.().then(
      (s) => setTrust(s),
      () => {
        /* keep the last state — best-effort chrome */
      },
    );
  };
  const handleSetTrust = (value: WorkspaceTrust | null): void => {
    void bridge.setWorkspaceTrust?.(value).then(
      (s) => setTrust(s),
      () => {
        /* unchanged — nothing was written */
      },
    );
  };
  const refreshMenu = (): void => {
    refreshRules();
    refreshTrust();
  };
  const handleReset = async () => {
    if (snap.sessionId === null) return;
    // Surface the refusal like its sibling above (audit 2026-07-24, M6):
    // main returns { ok:false, message:"a turn is in progress" } for exactly
    // this case, and discarding it meant 恢复默认 silently no-opped mid-turn —
    // the menu closed, nothing changed, and the user believed they had
    // reverted while 板砖 kept writing to the custom folder.
    const res = await bridge.resetWorkspace(snap.sessionId);
    if (!res.ok) setWsError(res.message ?? t("card.workspaceSetError"));
    else setWsError(null);
  };
  return (
    <section
      className="device-card atelier-device-card"
      data-state={state}
      aria-label={t("device.ariaLabel", { state: t(STATE_KEY[state]) })}
    >
      <CardMenu
        key={snap.sessionId ?? "no-session"}
        cardKind="device"
        activeWorkspace={snap.backendWorkspace ?? undefined}
        isDefault={snap.backendWorkspaceIsDefault}
        onSetWorkspace={() => void handleSet()}
        onResetWorkspace={handleReset}
        errorText={wsError ?? undefined}
        rules={rulesSupported ? rules : undefined}
        onRemoveRule={handleRemoveRule}
        trust={trustSupported && trust !== null ? trust : undefined}
        onSetTrust={handleSetTrust}
        onOpen={refreshMenu}
      />
      <img className="atelier-device-mark" src={atelierMark} alt="" />
      <p className="atelier-device-title">{t("baseline.workspace")}</p>
      <p className="atelier-device-state">{t(STATE_KEY[state])}</p>
      <p className="atelier-device-path">
        {snap.backendWorkspace ?? t("baseline.workspaceUnselected")}
      </p>
    </section>
  );
}
