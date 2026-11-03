import type { ExecutablePluginCapability, ExecutablePluginCapabilityName, ExecutablePluginManifest, ExecutablePluginModule } from "./executable-plugins.js";
import type { PluginRunResult } from "./plugin-runtime.js";
import type { PluginControlledView } from "./plugin-view.js";
import type { PluginStorageSnapshot } from "./plugin-storage.js";
import type { PrivatePluginDataAction, PrivatePluginDataPreview, PrivatePluginDataResult } from "./plugin-private-data.js";
import type { PluginMaintenancePreview, PluginMaintenanceResult } from "./plugin-maintenance.js";
import type { PluginWorkshopReply, PluginWorkshopRequest } from "./plugin-workshop.js";
import type { PluginNetworkSettingsRequest, PluginNetworkSettingsSnapshot } from "./plugin-network-settings.js";
import type { PluginArtifact, PluginPatchProposal, PluginOutputRequest, PluginOutputSnapshot, PluginPatchContent } from "./plugin-deliverables.js";

export interface ExecutablePluginVersion { readonly contentHash: string; readonly version: string; readonly installedAt: string }
export interface InstalledExecutablePlugin {
  readonly manifest: ExecutablePluginManifest;
  readonly contentHash: string;
  readonly enabled: boolean;
  readonly grantRevision: number;
  readonly grantedCapabilities: readonly ExecutablePluginCapability[];
  /** At most three earlier versions, newest first; active version is separate. */
  readonly history: readonly ExecutablePluginVersion[];
  readonly installedAt: string;
  readonly updatedAt: string;
}
export interface ExecutablePluginSnapshot {
  readonly revision: number;
  /** Monotonic within this host process; never restored from an old backup. */
  readonly hostRevision: number;
  readonly items: readonly InstalledExecutablePlugin[];
  readonly damaged?: boolean;
}
/** Frozen package content, never a path to live profile or workspace files. */
export interface ExecutablePluginFileChange {
  readonly path: string;
  readonly kind: "manifest" | "module";
  readonly change: "added" | "modified" | "removed" | "unchanged";
  readonly before: string | null;
  readonly after: string | null;
  readonly diff: string;
  readonly additions: number;
  readonly deletions: number;
}
export interface ExecutablePluginPreview {
  readonly id: string;
  readonly manifest: ExecutablePluginManifest;
  readonly contentHash: string;
  readonly files: readonly ExecutablePluginModule[];
  readonly baseContentHash: string | null;
  readonly changes: readonly ExecutablePluginFileChange[];
  readonly existing?: InstalledExecutablePlugin;
  readonly source: "file" | "rollback" | "generated";
  readonly identical: boolean;
}
export type ExecutablePluginManagementRequest =
  | { kind: "list" } | { kind: "preview" } | { kind: "restore" } | { kind: "reset" }
  | { kind: "discard"; previewId: string }
  | { kind: "confirm"; previewId: string; revision: number; grants: readonly ExecutablePluginCapabilityName[] }
  | { kind: "rollback-preview"; id: string; contentHash: string; revision: number }
  | { kind: "enable"; id: string; enabled: boolean; revision: number }
  | { kind: "remove"; id: string; revision: number }
  | { kind: "grants"; id: string; grants: readonly ExecutablePluginCapabilityName[]; revision: number };
export type ExecutablePluginManagementReply =
  | { ok: true; snapshot: ExecutablePluginSnapshot; preview?: ExecutablePluginPreview }
  | { ok: false; message: string };

export interface ExecutablePluginRunView {
  readonly id: string;
  readonly scope: "chat" | "workbench";
  readonly target: string;
  readonly draftRevision: number;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly result?: PluginRunResult;
  /** A proposal only. The renderer must recheck target/revision and require a click to insert. */
  readonly draftProposal?: string;
  readonly logs: readonly { level: "info" | "warn" | "error"; message: string }[];
  readonly progress?: { message: string; value?: number };
  /** Data rendered by host components, never plugin HTML or executable UI. */
  readonly controlledView?: PluginControlledView;
  /** Committed host results survive a later Guest failure or cancellation. */
  readonly artifacts?: readonly PluginArtifact[];
  readonly proposals?: readonly PluginPatchProposal[];
}
export type ExecutablePluginRequest = ExecutablePluginManagementRequest
  | PluginNetworkSettingsRequest
  | PluginWorkshopRequest
  | PluginOutputRequest
  | { kind: "storage-usage" }
  | { kind: "private-data-preview"; pluginId: string; action: PrivatePluginDataAction; hostRevision: number }
  | { kind: "private-data-confirm"; previewId: string; hostRevision: number }
  | { kind: "private-data-discard"; previewId: string }
  | { kind: "maintenance-preview"; hostRevision: number }
  | { kind: "maintenance-confirm"; previewId: string; selectedIds: readonly string[]; hostRevision: number }
  | { kind: "maintenance-discard"; previewId: string }
  | { kind: "run"; pluginId: string; contentHash: string; actionId: string; scope: "chat" | "workbench"; target: string; inputJson: string; draftRevision: number }
  | { kind: "view-action"; runId: string; viewId: string; viewRevision: number; buttonId: string; inputJson: string; draftRevision: number }
  | { kind: "status" | "cancel"; runId: string };
export type ExecutablePluginReply =
  | ({ ok: true; snapshot?: ExecutablePluginSnapshot; preview?: ExecutablePluginPreview; availableCapabilities?: readonly ExecutablePluginCapabilityName[]; run?: ExecutablePluginRunView;
      outputs?: PluginOutputSnapshot; artifact?: PluginArtifact; content?: string; patch?: PluginPatchContent; saved?: boolean; applying?: boolean; storage?: PluginStorageSnapshot;
      privateDataPreview?: PrivatePluginDataPreview; privateDataResult?: PrivatePluginDataResult; networkSettings?: PluginNetworkSettingsSnapshot;
      maintenancePreview?: PluginMaintenancePreview; maintenanceResult?: PluginMaintenanceResult } & Omit<Extract<PluginWorkshopReply, { ok: true }>, "ok">)
  | { ok: false; message: string };
