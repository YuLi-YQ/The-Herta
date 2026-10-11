import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
export const writeNewFileInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path must be non-empty")
      .describe(
        "Workspace-relative path of the file to create. It must not exist yet; use edit_file for an existing file.",
      ),
    content: z.string().describe("The whole content of the new file."),
  })
  .strict();

export type WriteNewFileInput = z.infer<typeof writeNewFileInputSchema>;

export const writeNewFileJsonSchema = zodToJsonSchema(writeNewFileInputSchema);
