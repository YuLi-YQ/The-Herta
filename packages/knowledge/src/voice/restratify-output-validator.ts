import { DeepSeekShapeError } from "../llm/types.js";
import type { Mood, RegisterMode } from "../schema.js";
import { RESTRATIFY_OUTPUT_SCHEMA_VERSION } from "./restratify-llm-prompt.js";

export type AddresseeClass =
  | "player"
  | "other_named"
  | "self_narration"
  | "unknown";

export interface RestratifyClassification {
  chunk_id: string;
  addressee_class: AddresseeClass;
  addressee_entity_id?: string;
  mood?: Mood;
  register_mode?: RegisterMode;
  grounded_citation: string;
  reasoning: string;
}

export interface RestratifyValidationContext {
  expectedChunkIds: ReadonlyArray<string>;
  knownEntityIds: ReadonlySet<string>;
  sourceHtml: string;
}

export interface RestratifyCoercion {
  chunk_id: string;
  reason: "hallucinated_entity" | "ungrounded_citation" | "unknown_class";
  original: unknown;
}

export interface RestratifyValidationResult {
  classifications: ReadonlyArray<RestratifyClassification>;
  coercions: ReadonlyArray<RestratifyCoercion>;
}

const VALID_CLASSES: ReadonlySet<AddresseeClass> = new Set([
  "player",
  "other_named",
  "self_narration",
  "unknown",
]);
const VALID_MOODS: ReadonlySet<Mood> = new Set([
  "pleased",
  "interested",
  "annoyed",
  "severe",
  "bored",
]);
const VALID_MODES: ReadonlySet<RegisterMode> = new Set([
  "technical",
  "casual",
  "teaching",
  "dramatic",
]);

export function validateRestratifyOutput(
  rawJsonText: string,
  ctx: RestratifyValidationContext,
): RestratifyValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch (err) {
    throw new DeepSeekShapeError(
      `JSON.parse failed: ${(err as Error).message}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    (parsed as Record<string, unknown>).schemaVersion !==
      RESTRATIFY_OUTPUT_SCHEMA_VERSION
  ) {
    throw new DeepSeekShapeError("schemaVersion mismatch");
  }
  const arr = (parsed as Record<string, unknown>).classifications;
  if (!Array.isArray(arr)) {
    throw new DeepSeekShapeError("classifications is not an array");
  }
  const byId = new Map<string, RestratifyClassification>();
  const coercions: RestratifyCoercion[] = [];

  for (const raw of arr) {
    if (typeof raw !== "object" || raw === null) {
      throw new DeepSeekShapeError("classification entry is not an object");
    }
    const r = raw as Record<string, unknown>;
    const chunk_id = String(r.chunk_id ?? "");
    if (!ctx.expectedChunkIds.includes(chunk_id)) {
      throw new DeepSeekShapeError(`unexpected chunk_id: ${chunk_id}`);
    }
    let addressee_class = String(r.addressee_class) as AddresseeClass;
    if (!VALID_CLASSES.has(addressee_class)) {
      coercions.push({
        chunk_id,
        reason: "unknown_class",
        original: r.addressee_class,
      });
      addressee_class = "unknown";
    }
    let addressee_entity_id: string | undefined;
    if (
      typeof r.addressee_entity_id === "string" &&
      r.addressee_entity_id.length > 0
    ) {
      addressee_entity_id = r.addressee_entity_id;
    }
    const grounded_citation =
      typeof r.grounded_citation === "string" ? r.grounded_citation : "";
    const reasoning = typeof r.reasoning === "string" ? r.reasoning : "";

    if (
      addressee_class === "other_named" &&
      (addressee_entity_id === undefined ||
        !ctx.knownEntityIds.has(addressee_entity_id))
    ) {
      coercions.push({
        chunk_id,
        reason: "hallucinated_entity",
        original: r.addressee_entity_id,
      });
      addressee_class = "unknown";
      addressee_entity_id = undefined;
    }

    if (
      addressee_class !== "unknown" &&
      (grounded_citation === "" ||
        grounded_citation.length > 30 ||
        !ctx.sourceHtml.includes(grounded_citation))
    ) {
      coercions.push({
        chunk_id,
        reason: "ungrounded_citation",
        original: grounded_citation,
      });
      addressee_class = "unknown";
      addressee_entity_id = undefined;
    }

    const mood =
      typeof r.mood === "string" && VALID_MOODS.has(r.mood as Mood)
        ? (r.mood as Mood)
        : undefined;
    const register_mode =
      typeof r.register_mode === "string" &&
      VALID_MODES.has(r.register_mode as RegisterMode)
        ? (r.register_mode as RegisterMode)
        : undefined;

    byId.set(chunk_id, {
      chunk_id,
      addressee_class,
      addressee_entity_id,
      mood,
      register_mode,
      grounded_citation,
      reasoning,
    });
  }

  for (const id of ctx.expectedChunkIds) {
    if (!byId.has(id)) {
      throw new DeepSeekShapeError(
        `missing classification for chunk_id: ${id}`,
      );
    }
  }

  return {
    classifications: Array.from(byId.values()),
    coercions,
  };
}
