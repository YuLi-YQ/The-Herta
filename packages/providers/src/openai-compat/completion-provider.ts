import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
} from "@herta/core";
import { ProviderError } from "../errors.js";
import { type ProviderUsage, reportProviderUsage } from "../usage.js";
import type { ApiKey } from "./api-key.js";
import { postCompletions } from "./completion-http.js";
import { mapCompletionStream } from "./completion-stream.js";
import { parseSSE } from "./sse.js";

export interface OpenAICompatibleCompletionProviderOpts {
  baseUrl: string;
  apiKey: ApiKey;
  /** Endpoint path appended to baseUrl. DeepSeek uses "/beta/completions".
   * Vanilla OpenAI legacy completions uses "/v1/completions" or just
   * "/completions" depending on baseUrl convention. */
  path: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Headers-phase deadline. Default 30s; 0 disables. See `CompletionHttpOpts`. */
  headersTimeoutMs?: number;
  /** SSE idle watchdog: max ms between body chunks before the stream is
   * treated as stalled. Default 90s; 0 disables. See `ParseSSEOpts`. */
  idleTimeoutMs?: number;
  /** Told each call's token usage as the API states it — in addition to the
   *  process-wide sink (`usage.ts`). */
  onUsage?: (usage: ProviderUsage) => void;
}

export class OpenAICompatibleCompletionProvider
  implements CompletionProviderAdapter
{
  constructor(private readonly opts: OpenAICompatibleCompletionProviderOpts) {}

  async *streamCompletion(
    request: CompletionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<CompletionEvent, void, void> {
    signal.throwIfAborted();

    const httpOpts: Parameters<typeof postCompletions>[0] = {
      baseUrl: this.opts.baseUrl,
      apiKey: this.opts.apiKey,
      path: this.opts.path,
      ...(this.opts.headers !== undefined
        ? { headers: this.opts.headers }
        : {}),
      ...(this.opts.fetchImpl !== undefined
        ? { fetchImpl: this.opts.fetchImpl }
        : {}),
      ...(this.opts.maxRetries !== undefined
        ? { maxRetries: this.opts.maxRetries }
        : {}),
      ...(this.opts.retryBaseMs !== undefined
        ? { retryBaseMs: this.opts.retryBaseMs }
        : {}),
      ...(this.opts.headersTimeoutMs !== undefined
        ? { headersTimeoutMs: this.opts.headersTimeoutMs }
        : {}),
    };

    const body = {
      model: request.model,
      prompt: request.prompt,
      stop: request.stop,
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    };

    const res = await postCompletions(httpOpts, body, signal);

    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "completion response had empty body",
      });
    }

    yield* mapCompletionStream(
      parseSSE(
        res.body,
        signal,
        this.opts.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: this.opts.idleTimeoutMs }
          : {},
      ),
      signal,
      (usage) => {
        const stated: ProviderUsage = {
          endpoint: "completion",
          model: request.model,
          ...usage,
        };
        this.opts.onUsage?.(stated);
        reportProviderUsage(stated);
      },
    );
  }
}
