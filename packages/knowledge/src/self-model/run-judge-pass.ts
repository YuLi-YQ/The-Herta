import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeepSeekClient } from "../llm/types.js";
import type { AntiPattern, DefaultRegister } from "../schema.js";
import { stripMarkdownFence } from "../text-utils.js";
import { buildJudgePrompt } from "./judge-prompt.js";
import {
  type HertaSelfModelV1,
  type JudgeReport,
  judgeReportSchema,
} from "./schema.js";

export interface RunJudgePassInput {
  selfModel: HertaSelfModelV1;
  voiceRegister: DefaultRegister;
  antiPatterns: ReadonlyArray<AntiPattern>;
  outPath: string;
  client: DeepSeekClient;
  model: string;
  dryRun?: boolean;
}

export interface RunJudgePassResult {
  report?: JudgeReport;
  minScore?: number;
  avgScore?: number;
  callsMade: number;
}

const RETRY_HINT = "Your previous output was malformed.";

/**
 * Pass 3b runner. Single LLM-judge call (with one retry on parse/schema
 * failure) producing a per-slot rubric report. Output is advisory —
 * the human reads the report alongside the self-model and decides
 * ship/iterate. Pass 4 (DB ingest) is gated on Pass 3a's hard-fail
 * checks, NOT on this judge's scores.
 */
export async function runJudgePass(
  input: RunJudgePassInput,
): Promise<RunJudgePassResult> {
  if (input.dryRun) {
    return { callsMade: 0 };
  }

  await fs.mkdir(path.dirname(input.outPath), { recursive: true });

  const prompt = buildJudgePrompt({
    selfModel: input.selfModel,
    voiceRegister: input.voiceRegister,
    antiPatterns: input.antiPatterns,
  });

  // Attempt 1.
  const first = await input.client.chatJson({
    systemPrompt: prompt.systemPrompt,
    userPayload: prompt.userPayload,
    model: input.model,
  });
  const firstParsed = parseJudgeOutput(first.rawJsonText);

  let report: JudgeReport;
  let callsMade = 1;
  if (firstParsed.ok) {
    report = firstParsed.report;
  } else {
    const retryPayload = `${prompt.userPayload}

${RETRY_HINT} ${firstParsed.code}: ${firstParsed.message}
Re-emit the JSON correctly. Output JSON only, no preamble, no markdown fences.`;

    const second = await input.client.chatJson({
      systemPrompt: prompt.systemPrompt,
      userPayload: retryPayload,
      model: input.model,
    });
    const secondParsed = parseJudgeOutput(second.rawJsonText);
    if (!secondParsed.ok) {
      throw new Error(
        `judge pass failed after retry: ${secondParsed.code}: ${secondParsed.message}`,
      );
    }
    report = secondParsed.report;
    callsMade = 2;
  }

  await fs.writeFile(
    input.outPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  const aggregates = aggregateScores(report);
  return { report, ...aggregates, callsMade };
}

type ParseResult =
  | { ok: true; report: JudgeReport }
  | { ok: false; code: "invalid_json" | "schema_invalid"; message: string };

function parseJudgeOutput(raw: string): ParseResult {
  const stripped = stripMarkdownFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      code: "invalid_json",
      message: (err as Error).message,
    };
  }
  const result = judgeReportSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      code: "schema_invalid",
      message: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, report: result.data };
}

function aggregateScores(report: JudgeReport): {
  minScore: number;
  avgScore: number;
} {
  const allScores: number[] = [];
  for (const slot of Object.values(report.scores)) {
    allScores.push(
      slot.in_voice,
      slot.canon_grounded,
      slot.coherent,
      slot.no_leakage,
    );
  }
  if (allScores.length === 0) return { minScore: 5, avgScore: 5 };
  const minScore = Math.min(...allScores);
  const avgScore = allScores.reduce((s, n) => s + n, 0) / allScores.length;
  return { minScore, avgScore };
}
