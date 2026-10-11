/** Per the official DeepSeek doc (verified 2026-07-11), the v4 models
 *  accept only these two efforts — "low"/"medium" were never valid. */
export type ReasoningEffort = "high" | "max";

export interface DisambiguationBatchInput {
  systemPrompt: string;
  userPayload: string; // JSON-stringified user content
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface DeepSeekChatResponse {
  rawJsonText: string; // the assistant message content as a JSON string
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface DeepSeekClient {
  chatJson(input: DisambiguationBatchInput): Promise<DeepSeekChatResponse>;
}

export class DeepSeekHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyExcerpt: string,
  ) {
    super(`DeepSeek API HTTP ${status}: ${bodyExcerpt.slice(0, 200)}`);
    this.name = "DeepSeekHttpError";
  }
}

export class DeepSeekShapeError extends Error {
  constructor(public readonly detail: string) {
    super(`DeepSeek response shape invalid: ${detail}`);
    this.name = "DeepSeekShapeError";
  }
}
