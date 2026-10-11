import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeepSeekClient } from "../llm/types.js";
import type { AntiPattern, DefaultRegister } from "../schema.js";
import type { HertaFacts, HertaSelfModelV1 } from "./schema.js";
import {
  parseSynthesisOutput,
  type SynthesisWarning,
} from "./synthesize-output-validator.js";
import { buildSynthesisPrompt } from "./synthesize-prompt.js";

export interface RunSynthesizePassInput {
  facts: HertaFacts;
  voiceRegister: DefaultRegister;
  antiPatterns: ReadonlyArray<AntiPattern>;
  /** Where the synthesized JSON is written. Parents auto-created. */
  outPath: string;
  client: DeepSeekClient;
  /** Model identifier (e.g., "deepseek-v4-pro"). */
  model: string;
  /** When true: no API calls, no outPath write. */
  dryRun?: boolean;
}

export interface RunSynthesizePassResult {
  /** The synthesized self-model. Undefined when dryRun is true. */
  selfModel?: HertaSelfModelV1;
  /** Heuristic voice warnings from the validator. */
  warnings: SynthesisWarning[];
  /** Number of LLM calls made (0, 1, or 2 depending on retry). */
  callsMade: number;
}

const RETRY_HINT_PREFIX = "Your previous output was malformed.";

/**
 * Pass 2 runner. Single LLM call (with one retry on parse/schema
 * failure) producing the full first-person self-model JSON.
 *
 * Retry policy: if the first response fails JSON.parse OR schema
 * validation, retry once with a hint appended to the user payload
 * explaining the prior failure. After the retry also fails, throw —
 * the human must investigate (likely a prompt issue, not transient).
 *
 * Network errors propagate immediately — no retry. The DS client itself
 * already retries on 5xx; persistent errors should surface promptly.
 */
export async function runSynthesizePass(
  input: RunSynthesizePassInput,
): Promise<RunSynthesizePassResult> {
  if (input.dryRun) {
    return { warnings: [], callsMade: 0 };
  }

  await fs.mkdir(path.dirname(input.outPath), { recursive: true });

  const prompt = buildSynthesisPrompt({
    facts: input.facts,
    voiceRegister: input.voiceRegister,
    antiPatterns: input.antiPatterns,
  });

  // Attempt 1.
  const first = await input.client.chatJson({
    systemPrompt: prompt.systemPrompt,
    userPayload: prompt.userPayload,
    model: input.model,
  });
  const firstParsed = parseSynthesisOutput(first.rawJsonText);

  if (firstParsed.ok) {
    await writeSelfModel(input.outPath, firstParsed.selfModel);
    return {
      selfModel: firstParsed.selfModel,
      warnings: firstParsed.warnings,
      callsMade: 1,
    };
  }

  // Attempt 2 — retry with hint.
  const retryPayload = `${prompt.userPayload}

${RETRY_HINT_PREFIX} ${firstParsed.code}: ${firstParsed.message}
Re-emit the JSON correctly. Output JSON only, no preamble, no markdown fences.`;

  const second = await input.client.chatJson({
    systemPrompt: prompt.systemPrompt,
    userPayload: retryPayload,
    model: input.model,
  });
  const secondParsed = parseSynthesisOutput(second.rawJsonText);

  if (!secondParsed.ok) {
    throw new Error(
      `synthesis failed after retry: ${secondParsed.code}: ${secondParsed.message}`,
    );
  }

  await writeSelfModel(input.outPath, secondParsed.selfModel);
  return {
    selfModel: secondParsed.selfModel,
    warnings: secondParsed.warnings,
    callsMade: 2,
  };
}

async function writeSelfModel(
  outPath: string,
  selfModel: HertaSelfModelV1,
): Promise<void> {
  await fs.writeFile(
    outPath,
    `${JSON.stringify(selfModel, null, 2)}\n`,
    "utf8",
  );
}
