/** R1 frozen contracts for R2 configuration and R3 protocol adapters.
 * These types do not implement a protocol or replace the upstream runtime. */
import type { ToolCallRequest, ToolResult, ToolSchema } from "@herta/core";

export type ProviderProtocol =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages";

export type CapabilitySupport = "unknown" | "supported" | "unsupported";
export type ModelValidationState =
  | "unverified"
  | "text-available"
  | "tools-available"
  | "failed";

export interface ModelCapabilities {
  readonly streaming: CapabilitySupport;
  readonly tools: CapabilitySupport;
  readonly images: CapabilitySupport;
  readonly reasoning: CapabilitySupport;
}

export interface ModelValidation {
  readonly state: ModelValidationState;
  readonly protocol: ProviderProtocol;
  readonly providerRevision: number;
  readonly checkedAt?: string;
  /** A redacted diagnostic, never a raw HTTP request/response or credential. */
  readonly diagnostic?: string;
}

export interface ProviderModel {
  readonly id: string;
  readonly alias?: string;
  readonly source: "discovered" | "manual";
  readonly capabilities: ModelCapabilities;
  readonly validation: ModelValidation;
}

/** Renderer-safe configuration. No secret value is present. */
export interface ProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  /** API root including the version/gateway prefix, never a full endpoint. */
  readonly baseURL: string;
  readonly authentication: "api-key" | "none";
  readonly credentialRef: string | null;
  readonly allowRemoteHTTP: boolean;
  readonly models: readonly ProviderModel[];
  readonly defaults: {
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  };
  /** Positive integer; credential/URL/protocol/model changes invalidate probes. */
  readonly revision: number;
}

export interface ModelBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

export interface RoleBindings {
  readonly persona: ModelBinding;
  /** Defaults to persona. Executor must have a matching tools-available probe. */
  readonly executor: ModelBinding;
}

export interface ProviderSettings {
  readonly schemaVersion: 1;
  readonly providers: readonly ProviderConfig[];
  readonly defaultBindings: RoleBindings | null;
  readonly sessionBindings: Readonly<Record<string, RoleBindings>>;
}

/** Deep-copy and freeze before dispatch. Edits apply only to the next turn. */
export interface TurnProviderSnapshot {
  readonly sessionId: string;
  readonly turnId: string;
  readonly bindings: RoleBindings;
  readonly persona: ProviderConfig;
  readonly executor: ProviderConfig;
}

export type NeutralMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls: readonly ToolCallRequest[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly result: ToolResult;
    };

/** Private native blocks may only be reused with this exact ownership. */
export interface NativeContext {
  readonly providerId: string;
  readonly providerRevision: number;
  readonly protocol: ProviderProtocol;
  readonly modelId: string;
  readonly opaque: unknown;
}

export interface ModelRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly modelId: string;
  /** Persona instructions or execution contract; no completion/prefill requirement. */
  readonly system: string;
  readonly messages: readonly NeutralMessage[];
  readonly tools: readonly ToolSchema[];
  readonly options: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly reasoningEffort?: string;
  };
  readonly nativeContext?: NativeContext;
  readonly signal: AbortSignal;
}

export type ModelEvent =
  | {
      readonly type: "public-reasoning-delta";
      readonly text: string;
      readonly format: "text" | "summary";
    }
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-arguments-delta";
      readonly callId: string;
      readonly tool: string;
      readonly delta: string;
    }
  /** Complete JSON and schema-valid only. Deltas never authorize execution. */
  | { readonly type: "tool-call-ready"; readonly call: ToolCallRequest }
  | {
      readonly type: "usage";
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheHitInputTokens?: number | null;
    }
  | {
      readonly type: "finished";
      readonly reason: "stop" | "tool-calls" | "length";
      readonly nativeContext?: NativeContext;
    };

export interface ModelPage {
  readonly models: readonly { readonly id: string; readonly alias?: string }[];
  readonly nextCursor: string | null;
}

/** Main-process only; key resolution and transport stay outside the renderer.
 * Errors throw ProviderError; abort is not completion. Adapters execute no tools.
 * Each named protocol requires its own implementation and independent tests. */
export interface ProtocolAdapter {
  readonly protocol: ProviderProtocol;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  listModels(input: {
    readonly cursor?: string;
    readonly signal: AbortSignal;
  }): Promise<ModelPage>;
}
