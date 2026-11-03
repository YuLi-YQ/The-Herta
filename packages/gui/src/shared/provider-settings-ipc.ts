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
  /** R109 (F06): what is known about each model's image result besides the result itself, from
   *  the record file beside the settings (provider-image-checks.ts). Only models with something
   *  to say are listed. */
  readonly imageChecks?: readonly ImageCheckView[];
  /** R109: the record file exists but cannot be read. It is left as it is until the user resets it;
   *  image results still work, only their dates are missing. */
  readonly imageCheckIssue?: "unreadable";
}

/** R109 (F06): an array, not a map keyed by model ID — a model may be called "__proto__". */
export interface ImageCheckView {
  readonly providerId: string;
  readonly modelId: string;
  /** When the model's current image result was measured. Absent for a result saved by an older
   *  version, or when its date could not be written. */
  readonly checkedAt?: string;
  /** The last image check ran on an earlier connection, whose change reset the result. */
  readonly connectionChanged?: true;
  /** R110: since the last image check, the service refused a request that carried pictures on
   *  this connection (HTTP 400/415/422). The cause is not known and the result was not changed;
   *  the next conclusive image check answers it. */
  readonly review?: {
    readonly at: string;
    readonly status: number;
    readonly surface: "chat" | "workbench";
  };
}

export interface ResetImageChecksResult {
  readonly view: ProviderSettingsView;
  /** The new name of the unreadable record file, kept beside the settings. */
  readonly preserved: string;
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
    | "search-limit"
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
    | "goal-damaged"
    | "cancelled"
    | "image-unsupported"
    | "image-unreadable"
    | "image-over-limit"
    | "image-rejected"
    | "image-too-large";
  readonly message: string;
  readonly stage: "configuration" | "request" | "stream";
  readonly status?: number;
  /** "attachment" (R98): the fix is a composer card, not the connection. */
  readonly action: "configure" | "credential" | "validate" | "retry" | "attachment" | "goal";
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
  /** `images` reads a generated picture back; it sets only `capabilities.images` and leaves the
   *  text/tool validation as it was. */
  readonly kind: "text" | "tools" | "images";
}
export interface ValidateProviderModelResult {
  readonly view: ProviderSettingsView;
  readonly validation: ModelValidation;
  /** Image probes only: whether the picture was read back, and why not. */
  readonly images?: { readonly supported: boolean; readonly diagnostic?: string };
  /** R104 (F06): the probe did not finish for a reason that says nothing about the model
   *  (credential, network, timeout, rate limit, server error); saved results were left as they were. */
  readonly kept?: { readonly reason: "authentication" | "transient"; readonly diagnostic: string };
  /** R104 (F06): a later probe of the same model started before this one finished; not saved. */
  readonly superseded?: true;
}
