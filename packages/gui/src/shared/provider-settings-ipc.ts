import type {
  ModelValidation,
  ProviderConfig,
  ProviderProtocol,
  ProviderSettings,
  RoleBindings,
} from "@herta/providers";

/** Renderer-safe settings and runtime availability; model validation is separate. */
export interface ProviderSettingsView {
  readonly settings: ProviderSettings;
  readonly credentialStatuses: Readonly<
    Record<string, { readonly set: boolean; readonly encrypted: boolean }>
  >;
  readonly runtimeActive: boolean;
}

export type ProviderReadinessCode =
  | "no-binding"
  | "missing-model"
  | "missing-credential"
  | "credential-unavailable"
  | "model-unverified"
  | "validation-expired"
  | "tools-unavailable"
  | "settings-unreadable";

export interface ProviderReadiness {
  readonly ready: boolean;
  readonly sessionId: string | null;
  readonly scope: "global" | "session";
  readonly bindings?: RoleBindings;
  readonly issue?: {
    readonly code: ProviderReadinessCode;
    readonly message: string;
    readonly action: "configure" | "credential" | "validate";
    readonly role?: "persona" | "executor";
  };
}

/** Finite safe diagnostics only; never render raw exceptions, request bodies or headers. */
export interface WorkbenchFailure {
  readonly code:
    | ProviderReadinessCode
    | "authentication"
    | "model-not-found"
    | "rate-limit"
    | "timeout"
    | "stream-interrupted"
    | "protocol-incompatible"
    | "tool-json"
    | "tool-schema"
    | "tool-unknown"
    | "tool-limit"
    | "tool-identity"
    | "tool-truncated"
    | "network"
    | "service-unavailable"
    | "cancelled";
  readonly message: string;
  readonly stage: "configuration" | "request" | "stream";
  readonly status?: number;
  readonly action: "configure" | "credential" | "validate" | "retry";
}

/** A key is write-only: returned views never contain a secret or key suffix. */
export interface SaveProviderInput {
  readonly id?: string;
  readonly expectedRevision?: number;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseURL: string;
  readonly authentication: "api-key" | "none";
  readonly allowRemoteHTTP: boolean;
  readonly models: readonly { readonly id: string; readonly alias?: string }[];
  readonly defaults: ProviderConfig["defaults"];
  readonly credential:
    | { readonly action: "keep" }
    | { readonly action: "clear" }
    | { readonly action: "replace"; readonly value: string };
}

export interface SetProviderBindingsInput {
  /** Absent means the global default; null bindings remove that selection. */
  readonly sessionId?: string;
  readonly bindings: RoleBindings | null;
}

export interface DiscoverProviderModelsInput {
  readonly providerId: string;
  readonly expectedRevision: number;
  readonly refresh?: boolean;
}
export interface DiscoverProviderModelsResult {
  readonly view: ProviderSettingsView;
  readonly models: readonly { readonly id: string; readonly alias?: string }[];
  readonly cached: boolean;
  readonly diagnostic?: string;
}
export interface ValidateProviderModelInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly expectedRevision: number;
  readonly kind: "text" | "tools";
}
export interface ValidateProviderModelResult {
  readonly view: ProviderSettingsView;
  readonly validation: ModelValidation;
}
