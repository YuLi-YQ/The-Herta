import type { ExecutablePluginPackage } from "./executable-plugins.js";
import type { ExecutablePluginCapabilityName } from "./executable-plugins.js";
import type { ExecutablePluginPreview, ExecutablePluginSnapshot } from "./executable-plugin-management.js";
import type { PluginTrialResult } from "./plugin-trial.js";
import type { PluginWorkshopDeletePreview, PluginWorkshopDeleteResult } from "./plugin-workshop-deletion.js";

export interface PluginWorkshopModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRevision: number;
  readonly reasoningEffort?: string;
}
export interface PluginWorkshopDraft {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly brief: string;
  readonly model: PluginWorkshopModel;
  readonly packageJson: string;
  readonly contentHash: string;
  readonly package: ExecutablePluginPackage;
}
export interface PluginWorkshopDraftSummary {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly version: string;
  readonly updatedAt: string;
  readonly contentHash: string;
}
export interface PluginWorkshopDraftList {
  readonly items: readonly PluginWorkshopDraftSummary[];
  /** Damaged or unknown entries stay on disk and are never interpreted as empty drafts. */
  readonly unreadable: number;
  /** Only host-validated draft IDs; never paths. */
  readonly damagedIds?: readonly string[];
}

export interface PluginWorkshopTarget {
  readonly id: string;
  readonly revision: number;
  readonly contentHash: string;
}
export interface PluginWorkshopJob {
  readonly id: string;
  readonly kind: "generate" | "trial";
  readonly status: "running" | "completed" | "failed" | "cancelled";
  /** A trial retains its slot until the isolated process has actually exited. */
  readonly busy: boolean;
  readonly target: PluginWorkshopTarget | null;
  readonly model?: PluginWorkshopModel;
  readonly chars: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly draft?: PluginWorkshopDraft;
  readonly trial?: PluginTrialResult;
  readonly message?: string;
}
export interface PluginWorkshopActionCheck {
  readonly actionId: string;
  readonly state: "not-run" | PluginTrialResult["outcome"];
  readonly scope?: "chat" | "workbench";
  readonly requestHash?: string;
}
export interface PluginWorkshopInstallation {
  readonly target: PluginWorkshopTarget;
  readonly hostRevision: number;
  readonly revision: number;
  readonly preview: ExecutablePluginPreview;
  /** Simulation evidence only; missing actions remain explicitly not-run. */
  readonly actions: readonly PluginWorkshopActionCheck[];
}
export type PluginWorkshopRequest =
  | { kind: "workshop-list" }
  | { kind: "workshop-get"; id: string }
  | { kind: "workshop-save"; target: PluginWorkshopTarget | null; brief: string; packageJson: string; model: PluginWorkshopModel }
  | { kind: "workshop-generate"; target: PluginWorkshopTarget | null; brief: string; model: PluginWorkshopModel }
  | { kind: "workshop-status" | "workshop-cancel"; jobId: string }
  | { kind: "workshop-trial"; target: PluginWorkshopTarget; actionId: string; scope: "chat" | "workbench"; inputJson: string; fixturesJson?: string }
  | { kind: "workshop-preview"; target: PluginWorkshopTarget; hostRevision: number }
  | { kind: "workshop-install"; target: PluginWorkshopTarget; previewId: string; hostRevision: number; revision: number; grants: readonly ExecutablePluginCapabilityName[] }
  | { kind: "workshop-discard"; previewId?: string }
  | { kind: "workshop-delete-preview"; id: string }
  | { kind: "workshop-delete-confirm" | "workshop-delete-discard"; previewId: string };
export type PluginWorkshopReply =
  | { ok: true; drafts?: PluginWorkshopDraftList; draft?: PluginWorkshopDraft; job?: PluginWorkshopJob;
      installation?: PluginWorkshopInstallation; trials?: readonly PluginTrialResult[]; snapshot?: ExecutablePluginSnapshot;
      deletePreview?: PluginWorkshopDeletePreview; deleteResult?: PluginWorkshopDeleteResult }
  | { ok: false; message: string };
