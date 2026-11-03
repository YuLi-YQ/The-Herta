import type { ExecutablePluginCapabilityName, ExecutablePluginHttpMethod } from "./executable-plugins.js";
import type { PluginRunResult, PluginRuntimeFaultCode, PluginJsonValue } from "./plugin-runtime.js";
import type { PluginControlledView } from "./plugin-view.js";

/** Host-owned frozen candidate; never a grant or an installed-plugin identity. */
export interface PluginTrialFrozen {
  readonly candidateId: string;
  readonly revision: number;
  readonly sourceHash: string;
  readonly contentHash: string;
  readonly packageJson: string;
}
export interface PluginTrialRequest {
  readonly actionId: string;
  readonly scope: "chat" | "workbench";
  readonly inputJson: string;
  /** Explicit synthetic data only. Missing network/command fixtures never imply success. */
  readonly fixturesJson?: string;
}
export interface PluginTrialFixtures {
  readonly workspace?: readonly { readonly path: string; readonly text: string }[];
  readonly privateValues?: Readonly<Record<string, PluginJsonValue>>;
  readonly network?: readonly { readonly url: string; readonly method: ExecutablePluginHttpMethod; readonly body?: string;
    readonly response: { readonly status: number; readonly contentType: string; readonly body: string } }[];
  readonly commands?: readonly { readonly argv: readonly string[]; readonly cwd?: string;
    readonly result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string } }[];
}
export interface PluginTrialTrace {
  readonly requestId: number;
  readonly capability: ExecutablePluginCapabilityName | null;
  readonly state: "requested" | "completed" | "rejected";
  readonly code?: PluginRuntimeFaultCode;
  readonly simulated: true;
}
export interface PluginTrialResult {
  readonly id: string;
  readonly candidateId: string;
  readonly revision: number;
  readonly sourceHash: string;
  readonly contentHash: string;
  readonly requestHash: string;
  readonly actionId: string;
  readonly scope: "chat" | "workbench";
  readonly simulated: true;
  readonly externalEnvironmentVerified: false;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unverified";
  readonly runtimeResult: PluginRunResult;
  readonly trace: readonly PluginTrialTrace[];
  readonly unverified: readonly { readonly capability: ExecutablePluginCapabilityName; readonly reason: string }[];
  readonly logs: readonly { readonly level: "info" | "warn" | "error"; readonly message: string }[];
  readonly progress?: { readonly message: string; readonly value?: number };
  readonly draftProposal?: string;
  readonly artifacts: readonly { readonly id: string; readonly name: string; readonly mime: string; readonly text: string; readonly bytes: number; readonly sha256: string }[];
  readonly proposals: readonly { readonly id: string; readonly path: string; readonly before: string | null; readonly after: string; readonly baseHash: string | null;
    readonly nextHash: string; readonly status: "pending" }[];
  readonly controlledView?: PluginControlledView;
  /** Conservative charged UTF-8 data, not a measurement of JS/process RSS. */
  readonly retainedBytes: number;
}
