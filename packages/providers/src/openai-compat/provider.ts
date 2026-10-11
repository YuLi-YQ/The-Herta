import type { PromptFrame, ProviderAdapter, ProviderEvent } from "@herta/core";
import { ProviderError } from "../errors.js";
import { type ProviderUsage, reportProviderUsage } from "../usage.js";
import type { ApiKey } from "./api-key.js";
import { postChatCompletions } from "./http.js";
import { parseSSE } from "./sse.js";
import { mapStream } from "./stream.js";
import { translate } from "./translate.js";

export interface OpenAICompatibleProviderOpts {
  baseUrl: string;
  apiKey: ApiKey;
  model: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Retry attempts for transient failures. Default 2. */
  maxRetries?: number;
  /** Base backoff for retry. Default 500ms. */
  retryBaseMs?: number;
  /** Headers-phase deadline. Default 30s; 0 disables. See `HttpOpts`. */
  headersTimeoutMs?: number;
  /** SSE idle watchdog: max ms between body chunks before the stream is
   * treated as stalled. Default 90s; 0 disables. See `ParseSSEOpts`. */
  idleTimeoutMs?: number;
  /** Told each call's token usage as the API states it — in addition to the
   *  process-wide sink (`usage.ts`). */
  onUsage?: (usage: ProviderUsage) => void;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  constructor(private readonly opts: OpenAICompatibleProviderOpts) {}

  async *streamChat(
    frame: PromptFrame,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent, void, void> {
    signal.throwIfAborted();
    const body = translate(frame, {
      model: this.opts.model,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      extraBody: this.opts.extraBody,
    });

    const res = await postChatCompletions(
      {
        baseUrl: this.opts.baseUrl,
        apiKey: this.opts.apiKey,
        model: this.opts.model,
        headers: this.opts.headers,
        fetchImpl: this.opts.fetchImpl,
        ...(this.opts.maxRetries !== undefined
          ? { maxRetries: this.opts.maxRetries }
          : {}),
        ...(this.opts.retryBaseMs !== undefined
          ? { retryBaseMs: this.opts.retryBaseMs }
          : {}),
        ...(this.opts.headersTimeoutMs !== undefined
          ? { headersTimeoutMs: this.opts.headersTimeoutMs }
          : {}),
      },
      body,
      signal,
    );

    if (res.body === null) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "response had empty body",
      });
    }

    yield* mapStream(
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
          endpoint: "chat",
          model: this.opts.model,
          ...usage,
        };
        this.opts.onUsage?.(stated);
        reportProviderUsage(stated);
      },
    );
  }
}
