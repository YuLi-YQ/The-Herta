/**
 * Streaming events from a completion-mode provider. Distinct from the
 * chat provider's `ProviderEvent` because completion mode has no tool
 * calls and no reasoning channel — just raw text and a finish signal.
 *
 * SPEC v0.2 §6.1.
 */
export type CompletionEvent =
  | { type: "text-delta"; text: string }
  | { type: "finish"; reason: "stop" | "length" | "error" };

/**
 * A single completion call's request. The provider implementation
 * translates this into the wire format (e.g., OpenAI-compatible
 * `/beta/completions`).
 *
 * `signal` is intentionally required on `streamCompletion` (not modeled
 * here) so call sites cannot forget cancellation. SPEC §6.1 prints
 * `signal?` but we elevate it to required to match the existing chat
 * provider's contract and our abort-aware HTTP/SSE machinery.
 */
export interface CompletionRequest {
  readonly model: string;
  readonly prompt: string;
  readonly stop: readonly string[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/**
 * The v0.2 actor provider contract. DeepSeek completion mode is the
 * canonical implementation per D8; no chat-mode actor fallback ships.
 * The backend coding agent uses the chat `ProviderAdapter` instead and
 * is unaffected by this type.
 */
export interface CompletionProviderAdapter {
  streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CompletionEvent>;
}
