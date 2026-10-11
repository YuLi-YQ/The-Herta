export interface ModelRates {
  /** USD per million input tokens. */
  readonly inputUsdPerMTok: number;
  /** USD per million output tokens. */
  readonly outputUsdPerMTok: number;
}

/**
 * Per-model rate table. Update when DeepSeek (or other provider) pricing
 * changes. The CLI's --budget-cap-usd uses these. Numbers reflect the
 * 2026-05-09 published rates and MUST be verified before any production run.
 */
export const MODEL_RATES = {
  "deepseek-v4-pro": {
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
  },
} as const satisfies Record<string, ModelRates>;

export interface EstimateCostInputDirect {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface EstimateCostInputPerCall {
  model: string;
  calls: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
}

export type EstimateCostInput =
  | EstimateCostInputDirect
  | EstimateCostInputPerCall;

export function estimateCostUsd(input: EstimateCostInput): number {
  const rates = MODEL_RATES[input.model as keyof typeof MODEL_RATES];
  if (rates === undefined) {
    throw new Error(`unknown model: ${input.model}`);
  }
  let inputTokens: number;
  let outputTokens: number;
  if ("calls" in input) {
    inputTokens = input.calls * input.inputTokensPerCall;
    outputTokens = input.calls * input.outputTokensPerCall;
  } else {
    inputTokens = input.inputTokens;
    outputTokens = input.outputTokens;
  }
  return (
    (inputTokens / 1_000_000) * rates.inputUsdPerMTok +
    (outputTokens / 1_000_000) * rates.outputUsdPerMTok
  );
}

export function formatCostUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
