import {
  type DeepSeekChatResponse,
  type DeepSeekClient,
  DeepSeekHttpError,
  DeepSeekShapeError,
  type DisambiguationBatchInput,
} from "./types.js";

/** One call's token counts as the API stated them (numbers only). */
export interface KnowledgeCallUsage {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** DeepSeek's prefix-cache split; null when the answer does not say. */
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
}

export interface RealDeepSeekClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  backoffMs?: number;
  /** Told each successful call's usage. The dream pass is the one consumer
   *  of the key that runs while the user is away, and its calls never
   *  reached the host's usage log (dream review 2026-09-22, finding 4): the
   *  host forwards these into the providers' process-wide sink. A throw
   *  here never reaches the call. */
  onUsage?: (usage: KnowledgeCallUsage) => void;
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;

export class RealDeepSeekClient implements DeepSeekClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly onUsage: ((usage: KnowledgeCallUsage) => void) | undefined;

  constructor(opts: RealDeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.onUsage = opts.onUsage;
  }

  async chatJson(
    input: DisambiguationBatchInput,
  ): Promise<DeepSeekChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body = JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPayload },
      ],
      ...(input.reasoningEffort !== undefined
        ? {
            thinking: { type: "enabled" },
            reasoning_effort: input.reasoningEffort,
          }
        : {}),
    });

    let attempt = 0;
    let lastErr: unknown;
    while (attempt < this.maxRetries) {
      attempt += 1;
      try {
        const resp = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
        if (resp.status >= 500) {
          const text = await safeReadText(resp);
          lastErr = new DeepSeekHttpError(resp.status, text);
          if (attempt < this.maxRetries) {
            await sleep(this.backoffMs * 2 ** (attempt - 1));
            continue;
          }
          throw lastErr;
        }
        if (!resp.ok) {
          const text = await safeReadText(resp);
          throw new DeepSeekHttpError(resp.status, text);
        }
        const json = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
          };
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new DeepSeekShapeError("missing choices[0].message.content");
        }
        const u = json.usage;
        const promptTokens = count(u?.prompt_tokens);
        const completionTokens = count(u?.completion_tokens);
        if (
          this.onUsage !== undefined &&
          promptTokens !== null &&
          completionTokens !== null
        ) {
          try {
            this.onUsage({
              model: typeof json.model === "string" ? json.model : input.model,
              promptTokens,
              completionTokens,
              cacheHitTokens: count(u?.prompt_cache_hit_tokens),
              cacheMissTokens: count(u?.prompt_cache_miss_tokens),
            });
          } catch {
            // observation must not break the call it observes
          }
        }
        return {
          rawJsonText: content,
          model: typeof json.model === "string" ? json.model : this.model,
          usage:
            json.usage === undefined
              ? undefined
              : {
                  promptTokens: json.usage.prompt_tokens,
                  completionTokens: json.usage.completion_tokens,
                  totalTokens: json.usage.total_tokens,
                },
        };
      } catch (err) {
        if (err instanceof DeepSeekShapeError) throw err;
        if (err instanceof DeepSeekHttpError && err.status < 500) throw err;
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(this.backoffMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("DeepSeek client exhausted retries");
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
