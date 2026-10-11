import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * A ref may contain `-` but may not START with one.
 *
 * `-` is a literal inside this character class, so the previous pattern
 * accepted `--ext-diff` and `-c` as refs — and git parses them as OPTIONS
 * (verified 2026-08-25: `git diff --stat --no-color --ext-diff` exits 0, where
 * a bogus ref exits 128). Since git honours the LAST occurrence of a repeated
 * option, a model-supplied ref could re-enable the external diff driver that
 * this tool passes `--no-ext-diff` to disable — in a `readOnly` tool that
 * raises no approval card. The argv also ends with `--`; this is the guard
 * that makes that redundant rather than the other way round.
 */
const REF_PATTERN = /^[A-Za-z0-9_.^~@][A-Za-z0-9_./^~@-]*$/;

export const gitDiffInputSchema = z
  .object({
    staged: z
      .boolean()
      .optional()
      .describe(
        "Diff the index against HEAD (staged changes) instead of the working tree.",
      ),
    ref: z
      .string()
      .min(1)
      .max(200)
      .regex(REF_PATTERN, "ref contains disallowed characters")
      .optional()
      .describe("Diff the working tree against this commit or branch."),
    base: z
      .string()
      .min(1)
      .max(200)
      .regex(REF_PATTERN, "base contains disallowed characters")
      .optional()
      .describe(
        "Diff HEAD against this commit or branch (what changed since `base`).",
      ),
    patch: z
      .boolean()
      .optional()
      .describe(
        "Include the unified patch text, not only the per-file stat. Default false.",
      ),
  })
  .strict()
  .refine(
    (v) =>
      [v.staged === true, v.ref !== undefined, v.base !== undefined].filter(
        Boolean,
      ).length <= 1,
    { message: "staged, ref and base are mutually exclusive" },
  );

export type GitDiffInput = z.infer<typeof gitDiffInputSchema>;

export const gitDiffJsonSchema = zodToJsonSchema(gitDiffInputSchema);
