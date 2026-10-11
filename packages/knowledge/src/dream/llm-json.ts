import type { DeepSeekClient, ReasoningEffort } from "../llm/types.js";

/**
 * The LLM call itself failed (network, HTTP status, response shape) — as
 * opposed to the model returning unparseable content. The pass treats this as
 * an abort signal: the in-flight episode is NOT recorded in the ledger, so it
 * stays undreamed and is retried on the next pass. Conflating the two (the old
 * behavior) meant a transient DeepSeek outage permanently consumed every
 * in-flight episode as "skipped"/"archived".
 */
export class DreamTransportError extends Error {
  constructor(public readonly detail: string) {
    super(`dream: LLM call failed: ${detail}`);
    this.name = "DreamTransportError";
  }
}

/**
 * Call the model and parse its JSON reply.
 *
 * - Call failure (client throw) → DreamTransportError, propagated so the pass
 *   aborts without consuming the episode.
 * - Parse failure on a successful response → undefined — a model-quality
 *   failure the caller may consume (skip/archive) like any other bad output.
 */
export async function jsonCall<T>(
  client: DeepSeekClient,
  prompt: { systemPrompt: string; userPayload: string },
  model: string,
  effort: ReasoningEffort,
): Promise<T | undefined> {
  let rawJsonText: string;
  try {
    const resp = await client.chatJson({
      ...prompt,
      model,
      reasoningEffort: effort,
    });
    rawJsonText = resp.rawJsonText;
  } catch (err) {
    throw new DreamTransportError(String(err));
  }
  try {
    return JSON.parse(rawJsonText) as T;
  } catch {
    return undefined;
  }
}
