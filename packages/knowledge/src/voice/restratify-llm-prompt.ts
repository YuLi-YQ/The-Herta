export const RESTRATIFY_OUTPUT_SCHEMA_VERSION = 1 as const;

export interface RestratifyChunk {
  chunk_id: string;
  ordinal: number;
  text: string;
}

export interface RestratifyPromptInput {
  sourceHtml: string;
  hertaChunks: ReadonlyArray<RestratifyChunk>;
}

export interface RestratifyPromptOutput {
  systemPrompt: string;
  userPayload: string;
}

const COMMON_SCHEMA_DOC = `
Output strictly valid JSON with this schema:

{
  "schemaVersion": ${RESTRATIFY_OUTPUT_SCHEMA_VERSION},
  "classifications": [
    {
      "chunk_id": "<one of the input chunk_ids>",
      "addressee_class": "player" | "other_named" | "self_narration" | "unknown",
      "addressee_entity_id": "<canon entity id, e.g. person.ruan_mei>" | null,
      "mood": "pleased" | "interested" | "annoyed" | "severe" | "bored" | null,
      "register_mode": "technical" | "casual" | "teaching" | "dramatic" | null,
      "grounded_citation": "<<=30 chars from the source HTML that justifies this verdict>",
      "reasoning": "<one short sentence explaining the verdict>"
    }
  ]
}

Constraints:
- Every input chunk_id must appear exactly once.
- grounded_citation MUST be a verbatim substring of the source HTML, length <= 30 chars.
- If you cannot find a grounded_citation, set addressee_class to "unknown" and set grounded_citation to "".
- addressee_entity_id is non-null only when addressee_class is "other_named".
- "player" means the player character (Trailblazer / 星 / 穹 / 开拓者).
- "self_narration" means Herta is narrating in her own writing/manuscripts; only set when source kind is book_readable authored by Herta.
`.trim();

export function buildRestratifyPromptA(
  input: RestratifyPromptInput,
): RestratifyPromptOutput {
  const systemPrompt = `You are analyzing dialogue from a video game.
Below the user message contains the full source HTML of a single in-game
scene, followed by a JSON list of dialogue chunks where the speaker is Herta
(黑塔). For each chunk, classify the addressee.

${COMMON_SCHEMA_DOC}

Think step by step before answering. Reason about who Herta is talking TO,
not who she is talking ABOUT.`;

  const userPayload = JSON.stringify({
    sourceHtml: input.sourceHtml,
    hertaChunks: input.hertaChunks,
  });
  return { systemPrompt, userPayload };
}

export function buildRestratifyPromptB(
  input: RestratifyPromptInput,
): RestratifyPromptOutput {
  const systemPrompt = `Below is a game scene HTML and a list of Herta-spoken
lines. For each Herta line, identify exactly who Herta is speaking to (not
who she is talking about). Cite the line of evidence — a quoted text excerpt
from the HTML — that proves your identification. If you cannot cite evidence,
mark the line as having an unknown addressee.

${COMMON_SCHEMA_DOC}

Pay particular attention to: who speaks immediately before and after each
Herta line, second-person pronouns directed at named entities, and stage-
direction-style HTML markers that disambiguate addressees.`;

  const userPayload = JSON.stringify({
    sceneHtml: input.sourceHtml,
    hertaLines: input.hertaChunks,
  });
  return { systemPrompt, userPayload };
}
