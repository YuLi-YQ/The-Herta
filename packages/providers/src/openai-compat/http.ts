import type { ApiKey } from "./api-key.js";
import { postJsonWithRetry } from "./retry-post.js";

export interface HttpOpts {
  baseUrl: string;
  apiKey: ApiKey;
  model: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Maximum retry attempts for retryable failures (network / 429 / 5xx).
   * Default: 2. Set to 0 to disable retries. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt with ±25% jitter.
   * Default: 500. */
  retryBaseMs?: number;
  /** Max ms to wait for response HEADERS before treating the attempt as a
   * retryable stall (hang audit 2026-07-09, H1). Applies to the headers
   * phase only — once headers arrive the SSE idle watchdog owns the body.
   * 0 disables. Default 30s. */
  headersTimeoutMs?: number;
}

/** POST `body` to `<baseUrl>/chat/completions`. Retry/deadline/error
 *  mapping live in `postJsonWithRetry` (shared with the completion endpoint). */
export function postChatCompletions(
  opts: HttpOpts,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  return postJsonWithRetry(
    {
      ...opts,
      url: `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
    },
    JSON.stringify(body),
    signal,
  );
}
