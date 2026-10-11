import { stripMarkdownFence } from "../text-utils.js";
import { type FileFacts, fileFactsSchema } from "./schema.js";

export interface ParseExtractionOutputInput {
  /** The filename we expected the LLM to echo back in the `source` field. */
  expectedSource: string;
  /**
   * Optional source text. When provided, the validator checks that each
   * evidence_excerpt is a substring of the source — fabricated quotes
   * surface as `ungrounded_evidence` warnings (non-fatal).
   */
  sourceText?: string;
}

export type ExtractionWarning = {
  kind: "ungrounded_evidence";
  fact_index: number;
  evidence_excerpt: string;
};

export type ParseExtractionOutputResult =
  | {
      ok: true;
      fileFacts: FileFacts;
      warnings: ExtractionWarning[];
    }
  | {
      ok: false;
      code: "invalid_json" | "schema_invalid" | "source_mismatch";
      message: string;
    };

/**
 * Parse and validate a per-file extraction LLM response.
 *
 * - Strips an optional markdown ```json fence (best-effort recovery —
 *   the prompt forbids fences but small models sometimes emit them).
 * - Parses JSON; returns invalid_json on failure.
 * - Validates against fileFactsSchema; returns schema_invalid on failure.
 * - Verifies the source field matches the expected filename.
 * - When sourceText is provided, checks each evidence_excerpt is a
 *   substring; non-substring excerpts are recorded as warnings (not
 *   errors — the model may have paraphrased a long excerpt).
 */
export function parseExtractionOutput(
  raw: string,
  input: ParseExtractionOutputInput,
): ParseExtractionOutputResult {
  const stripped = stripMarkdownFence(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      code: "invalid_json",
      message: `failed to parse as JSON: ${(err as Error).message}`,
    };
  }

  const result = fileFactsSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      code: "schema_invalid",
      message: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  const fileFacts = result.data;
  if (fileFacts.source !== input.expectedSource) {
    return {
      ok: false,
      code: "source_mismatch",
      message: `expected source "${input.expectedSource}", got "${fileFacts.source}"`,
    };
  }

  const warnings: ExtractionWarning[] = [];
  if (input.sourceText !== undefined) {
    fileFacts.facts.forEach((fact, index) => {
      if (!input.sourceText?.includes(fact.evidence_excerpt)) {
        warnings.push({
          kind: "ungrounded_evidence",
          fact_index: index,
          evidence_excerpt: fact.evidence_excerpt,
        });
      }
    });
  }

  return { ok: true, fileFacts, warnings };
}
