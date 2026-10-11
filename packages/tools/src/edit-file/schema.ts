import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped —
// on a MUTATION tool a misdirected key deserves a hard stop, not a guess.
export const editFileHunkSchema = z
  .object({
    search: z
      .string()
      .min(1, "search must be non-empty")
      .describe(
        "Exact text to find in the file, verbatim including whitespace; it must occur exactly once.",
      ),
    replace: z
      .string()
      .describe("Text that replaces `search`. May be empty to delete it."),
  })
  .strict();

export const editFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path must be non-empty")
      .describe("Workspace-relative path of an existing file you have read."),
    hunks: z
      .array(editFileHunkSchema)
      .min(1, "hunks must be non-empty")
      .describe("One or more search/replace pairs, applied together."),
  })
  .strict();

export type EditFileInput = z.infer<typeof editFileInputSchema>;

export const editFileJsonSchema = zodToJsonSchema(editFileInputSchema);
