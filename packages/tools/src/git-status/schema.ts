import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const gitStatusInputSchema = z.object({}).strict();
export type GitStatusInput = z.infer<typeof gitStatusInputSchema>;

export const gitStatusJsonSchema = zodToJsonSchema(gitStatusInputSchema);
