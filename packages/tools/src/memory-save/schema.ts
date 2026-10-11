import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const memorySaveInputSchema = z
  .object({
    kind: z
      .enum([
        "build_command",
        "test_command",
        "style_preference",
        "repo_fact",
        "known_flaky_test",
        "recurring_mistake",
        "herta_lesson",
      ])
      .describe("What kind of operational fact this is."),
    text: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "The fact itself, one sentence, at most 500 characters. Never a secret.",
      ),
  })
  .strict();

export type MemorySaveInput = z.infer<typeof memorySaveInputSchema>;

export const memorySaveJsonSchema = zodToJsonSchema(memorySaveInputSchema);
