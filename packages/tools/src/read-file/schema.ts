import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): a wrong optional key name (`startLine` for `offset`)
// used to be silently stripped — the read succeeded from line 1 instead of
// the range the model asked for.
// Every field describes itself (2026-09-18): the model-facing JSON schema
// is generated from this object, and a schema with names and types alone
// is what made the first call of a tool a guess.
export const readFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path must be non-empty")
      .describe("Workspace-relative path of the file to read."),
    offset: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe("First line to return, 1-based. Default 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Maximum number of lines to return from `offset`."),
  })
  .strict();

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export const readFileJsonSchema = zodToJsonSchema(readFileInputSchema);
