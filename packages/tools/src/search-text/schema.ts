import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31, with the rest of the tool schemas): non-strict zod
// silently strips wrong OPTIONAL key names (`context` for `contextLines`,
// `max` for `maxMatches`), running the search with defaults instead of
// telling the model which key it misspelled.
export const searchTextInputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, "pattern must be non-empty")
      .describe("Regular expression to search for (ripgrep syntax)."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Workspace-relative file or directory to search. Default: the workspace root.",
      ),
    caseSensitive: z
      .boolean()
      .optional()
      .describe("Match case exactly. Default false."),
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Lines of context each side of a match, 0–5. Default 0."),
    maxMatches: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Cap on matches returned."),
  })
  .strict();

export type SearchTextInput = z.infer<typeof searchTextInputSchema>;

export const searchTextJsonSchema = zodToJsonSchema(searchTextInputSchema);
