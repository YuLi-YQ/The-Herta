import type { ApiKey } from "./api-key.js";
import { postJsonWithRetry } from "./retry-post.js";

export interface CompletionHttpOpts {
  baseUrl: string;
  apiKey: ApiKey;
  /** Endpoint path appended to baseUrl. DeepSeek factory passes "/beta/completions". */
  path: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Maximum retry attempts for retryable failures (network / 429 / 5xx).
   * Default: 2. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt with ±25% jitter. Default 500. */
  retryBaseMs?: number;
  /** Max ms to wait for response HEADERS before treating the attempt as a
   * retryable stall (hang audit 2026-07-09, H1). Headers phase only — once
   * headers arrive the SSE idle watchdog owns the body. 0 disables.
   * Default 30s. */
  headersTimeoutMs?: number;
}

export interface CompletionRequestBody {
  model: string;
  prompt: string;
  stop: readonly string[];
  maxTokens?: number;
  temperature?: number;
}

/** POST a completion request to `<baseUrl><path>`. Retry/deadline/error
 *  mapping live in `postJsonWithRetry` (shared with the chat endpoint). */
export function postCompletions(
  opts: CompletionHttpOpts,
  body: CompletionRequestBody,
  signal: AbortSignal,
): Promise<Response> {
  // Translate to wire shape: max_tokens (not maxTokens), stream: true, drop undefined.
  const wireBody: Record<string, unknown> = {
    model: body.model,
    prompt: body.prompt,
    stop: body.stop,
    stream: true,
  };
  if (body.maxTokens !== undefined) wireBody.max_tokens = body.maxTokens;
  if (body.temperature !== undefined) wireBody.temperature = body.temperature;
  return postJsonWithRetry(
    { ...opts, url: `${opts.baseUrl.replace(/\/$/, "")}${opts.path}` },
    JSON.stringify(wireBody),
    signal,
  );
}
