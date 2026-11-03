/** Host-owned, persistent results. Never interpreted as chat messages or model attachments. */
export interface PluginOutputOwner { readonly scope: "chat" | "workbench"; readonly target: string }
export interface PluginOutputProducer {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly grantRevision: number;
}
export type PluginArtifactMime = "text/plain" | "text/markdown" | "text/csv" | "application/json";
export interface PluginArtifact {
  readonly id: string;
  readonly name: string;
  readonly mime: PluginArtifactMime;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly producer: PluginOutputProducer;
  readonly runId: string;
}
export type PluginPatchStatus = "pending" | "applying" | "applied" | "denied" | "cancelled" | "conflict" | "failed" | "needs-review";
export interface PluginPatchProposal {
  readonly id: string;
  readonly path: string;
  readonly baseHash: string | null;
  readonly nextHash: string;
  readonly createdAt: string;
  readonly producer: PluginOutputProducer;
  readonly runId: string;
  readonly status: PluginPatchStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly appliedAt?: string;
  readonly message?: string;
}
export interface PluginPatchContent {
  readonly proposal: PluginPatchProposal;
  readonly before: string | null;
  readonly after: string;
  readonly diff: string;
}
export interface PluginOutputSnapshot {
  readonly artifacts: readonly PluginArtifact[];
  readonly proposals: readonly PluginPatchProposal[];
  readonly damagedArtifacts: number;
  readonly damagedProposals: number;
}
export type PluginOutputRequest =
  | (PluginOutputOwner & { kind: "outputs-list" })
  | (PluginOutputOwner & { kind: "artifact-read" | "artifact-save" | "patch-read" | "patch-apply" | "patch-cancel"; id: string });
export type PluginOutputReply =
  | { ok: true; outputs?: PluginOutputSnapshot; artifact?: PluginArtifact; content?: string; patch?: PluginPatchContent; saved?: boolean; applying?: boolean }
  | { ok: false; message: string };
