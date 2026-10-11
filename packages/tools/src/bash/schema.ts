import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** The trained shape's single parameter (ADR 0040): one shell command. */
export const bashInputSchema = z
  .object({
    command: z.string().min(1, "command must be non-empty"),
  })
  .strict();

export type BashInput = z.infer<typeof bashInputSchema>;

/** Hand-written rather than zodToJsonSchema so the wire shape is exactly the
 *  one the model was trained on (a bare object with `command`). */
export const bashJsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "The bash command to run." },
  },
  required: ["command"],
} as const;

// zodToJsonSchema is what the sibling schemas use; keep the import live so
// the two shapes cannot silently drift (a test compares them).
export const bashZodJsonSchema = zodToJsonSchema(bashInputSchema);
