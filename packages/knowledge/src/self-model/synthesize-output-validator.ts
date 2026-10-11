import { stripMarkdownFence } from "../text-utils.js";
import { type HertaSelfModelV1, hertaSelfModelV1Schema } from "./schema.js";

export type SynthesisWarning =
  | { kind: "third_person_voice"; slot: string; sample: string }
  | { kind: "cli_as_self"; slot: string; sample: string }
  | { kind: "ni_hao_opener"; slot: string; sample: string };

export type ParseSynthesisOutputResult =
  | {
      ok: true;
      selfModel: HertaSelfModelV1;
      warnings: SynthesisWarning[];
    }
  | {
      ok: false;
      code: "invalid_json" | "schema_invalid";
      message: string;
    };

/**
 * Parse and validate a Pass 2 synthesis LLM response. Strips an
 * optional ```json fence (best-effort recovery), parses JSON, validates
 * against hertaSelfModelV1Schema, then runs heuristic voice checks
 * that surface as non-fatal warnings:
 *
 * - third_person_voice: prose contains "Herta is" / "Herta does" / "She is"
 *   in a first-person section
 * - cli_as_self: harness_proprioception prose contains "I am.*CLI" or
 *   "this is my form" or similar self-as-CLI framings
 * - ni_hao_opener: biography or interaction_register prose opens with "你好"
 *
 * Warnings do NOT block the result — the human reviews the JSON and
 * decides ship/iterate.
 */
export function parseSynthesisOutput(raw: string): ParseSynthesisOutputResult {
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

  const result = hertaSelfModelV1Schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      code: "schema_invalid",
      message: result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }

  const selfModel = result.data;
  const warnings: SynthesisWarning[] = [];

  // Third-person voice check across first-person slots.
  const FIRST_PERSON_SLOTS = [
    { slot: "biography", prose: selfModel.biography.prose },
    { slot: "philosophy", prose: selfModel.philosophy.prose },
    { slot: "embodiment", prose: selfModel.embodiment.prose },
    {
      slot: "harness_proprioception",
      prose: selfModel.harness_proprioception.prose,
    },
    {
      slot: "interaction_register",
      prose: selfModel.interaction_register.prose,
    },
  ];

  for (const { slot, prose } of FIRST_PERSON_SLOTS) {
    const tpMatch = /\b(Herta|She)\s+(is|does|has|works|lives)\b/.exec(prose);
    if (tpMatch !== null) {
      warnings.push({
        kind: "third_person_voice",
        slot,
        sample: tpMatch[0],
      });
    }
  }

  // CLI-as-self check (specifically against harness_proprioception).
  const cliSelfRegex =
    /\b(I am|我是).{0,12}(CLI|terminal|文字通道)|this is my form|我的形态|是我的.{0,4}形态/i;
  const harnessProse = selfModel.harness_proprioception.prose;
  if (cliSelfRegex.test(harnessProse)) {
    warnings.push({
      kind: "cli_as_self",
      slot: "harness_proprioception",
      sample: harnessProse.slice(0, 80),
    });
  }

  // 你好 opener check on biography + interaction_register.
  const NI_HAO_SLOTS = [
    { slot: "biography", prose: selfModel.biography.prose },
    {
      slot: "interaction_register",
      prose: selfModel.interaction_register.prose,
    },
  ];
  for (const { slot, prose } of NI_HAO_SLOTS) {
    if (/^\s*你好/.test(prose)) {
      warnings.push({
        kind: "ni_hao_opener",
        slot,
        sample: prose.slice(0, 30),
      });
    }
  }

  return { ok: true, selfModel, warnings };
}
