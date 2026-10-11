import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): unknown keys are named instead of silently stripped.
export const globInputSchema = z
  .object({
    pattern: z
      .string()
      .min(1, "pattern must be non-empty")
      .max(200)
      .describe(
        "Glob pattern relative to `path`, e.g. `src/**/*.ts` or `*.md`.",
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Workspace-relative directory to search in. Default: the workspace root.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("Cap on matches returned."),
  })
  .strict();

export type GlobInput = z.infer<typeof globInputSchema>;

export const globJsonSchema = zodToJsonSchema(globInputSchema);
