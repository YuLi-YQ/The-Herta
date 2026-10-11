/**
 * What one model call cost, as the API itself counted it (perf audit
 * 2026-09-20).
 *
 * The runtime never read the `usage` block: token budgets run on the
 * harness's own estimate, and the prompt cache — the one thing the static
 * prefix, the tail-placed hints and the per-session toolset (ADR 0067) all
 * exist to protect — was judged by reading bytes, never by the number the
 * server reports. `prompt_cache_hit_tokens` answers it per call.
 *
 * DeepSeek states usage ON the chunk that carries `finish_reason`, on both
 * endpoints, with no `stream_options` asked for (probed live 2026-09-20;
 * asking only adds `"usage": null` to the other chunks). So reading it
 * changes no request byte and no consumer: every stream reader in the
 * codebase stops at `finish`, and the mapper has the numbers in hand one
 * statement before it yields that event. A gateway that follows OpenAI
 * instead — a trailing chunk with empty `choices` — is read too when a
 * consumer drains that far; when it does not, the call simply goes
 * uncounted.
 *
 * A process-wide injection point, like the transport (`transport.ts`), and
 * for the same reason: a dozen construction sites — actor, backend, router,
 * supervisor, judges, title, recap, digest, vision — are a dozen chances to
 * miss one. The host installs one sink; a provider that is handed an
 * explicit `onUsage` reports there as well.
 *
 * Numbers only. No prompt text, no completion text, no key, no session
 * identity: the sink learns which endpoint and model answered and how many
 * tokens moved, nothing else.
 */
export interface ProviderUsage {
  /** Which wire shape answered: chat (`/chat/completions`) or completion
   *  (`/beta/completions` — the narrative actor). */
  readonly endpoint: "chat" | "completion";
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Prompt tokens served from the provider's prefix cache / not. Both
   *  `null` when the provider does not say (a non-DeepSeek gateway). */
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  /** Who made the call when it is not the session's own providers: "dream"
   *  for the idle pass (its client is @herta/knowledge's, not these).
   *  Absent = the actor, 板砖 or a sidecar. */
  readonly source?: "dream";
}

export type ProviderUsageSink = (usage: ProviderUsage) => void;

let installed: ProviderUsageSink | undefined;

/** Install the process-wide usage sink. `undefined` removes it. */
export function setProviderUsageSink(
  sink: ProviderUsageSink | undefined,
): void {
  installed = sink;
}

/** Hand one call's usage to the installed sink. A sink that throws never
 *  reaches the stream it is observing. */
export function reportProviderUsage(usage: ProviderUsage): void {
  if (installed === undefined) return;
  try {
    installed(usage);
  } catch {
    // observation must not break the call it observes
  }
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Read a stream chunk's `usage` object. `null` when the chunk carries none
 * (absent, or the `null` placeholder) or the block is not usage-shaped.
 * The cache pair is DeepSeek's spelling; OpenAI's
 * `prompt_tokens_details.cached_tokens` is accepted as the hit count.
 */
export function parseUsageChunk(
  chunk: unknown,
): Omit<ProviderUsage, "endpoint" | "model"> | null {
  if (chunk === null || typeof chunk !== "object") return null;
  const u = (chunk as { usage?: unknown }).usage;
  if (u === null || typeof u !== "object") return null;
  const raw = u as Record<string, unknown>;
  const promptTokens = count(raw.prompt_tokens);
  const completionTokens = count(raw.completion_tokens);
  if (promptTokens === null || completionTokens === null) return null;
  const details = raw.prompt_tokens_details;
  const hit =
    count(raw.prompt_cache_hit_tokens) ??
    (details !== null && typeof details === "object"
      ? count((details as Record<string, unknown>).cached_tokens)
      : null);
  const miss =
    count(raw.prompt_cache_miss_tokens) ??
    (hit !== null ? Math.max(0, promptTokens - hit) : null);
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}
