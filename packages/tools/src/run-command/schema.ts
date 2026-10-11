import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Strict (2026-07-31): a wrong optional key name (`timeout` for `timeoutMs`,
// `background` for `runInBackground`) used to be silently stripped — the
// command ran with defaults instead of what the model asked for.
export const runCommandInputSchema = z
  .object({
    argv: z
      .array(z.string().min(1, "argv entry must be non-empty"))
      .min(1, "argv must be non-empty")
      .describe(
        'The program and its arguments as separate strings, e.g. ["npm", "test"]. No shell: pipes and redirects are not interpreted.',
      ),
    outputEncoding: z
      .enum(["utf-8", "gb18030", "utf-16le"])
      .optional()
      .describe(
        "Encoding emitted by this command, for stdout and stderr. Default UTF-8; Windows cmd/legacy PowerShell use the console Chinese code page when detected, cmd /u uses UTF-16LE. Set explicitly for tools that override their shell encoding (for example UTF-8 Python or chcp 65001). This only decodes output; it does not modify command behavior.",
      ),
    cwd: z
      .string()
      .min(1, "cwd must be non-empty")
      .optional()
      .describe(
        "Workspace-relative working directory. Default: the workspace root.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1, "timeoutMs must be positive")
      .max(600_000, "timeoutMs must be ≤ 600000")
      .optional()
      .describe(
        "Kill the command after this many milliseconds. Default 120000, maximum 600000.",
      ),
    /** Extra environment for the child (ADR 0025 slice 4). Merged over the
     *  inherited env; a fixed denylist of escalation-prone keys (PATH,
     *  NODE_OPTIONS, LD_*, git exec hooks, …) is rejected. */
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Extra environment variables for this command only. PATH and loader variables are refused.",
      ),
    /** Start the command in the background (ADR 0025 slice 4). Returns
     *  immediately with a backgroundId; read output with command_output,
     *  stop with command_stop. For long-running processes (dev servers,
     *  watchers). */
    runInBackground: z
      .boolean()
      .optional()
      .describe(
        "Start the command in the background and return a backgroundId at once; read its output with command_output and stop it with command_stop. For servers and watchers.",
      ),
  })
  .strict();

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;

export const runCommandJsonSchema = zodToJsonSchema(runCommandInputSchema);

export const commandOutputInputSchema = z
  .object({
    backgroundId: z
      .string()
      .min(1)
      .describe("The id run_command returned for the background command."),
    /** Return only output appended since the given byte offset into the
     *  merged stream (default 0 = from the start). */
    sinceByte: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Return only output after this byte offset of the merged stream. Default 0 (from the start).",
      ),
  })
  .strict();
export type CommandOutputInput = z.infer<typeof commandOutputInputSchema>;
export const commandOutputJsonSchema = zodToJsonSchema(
  commandOutputInputSchema,
);

export const commandStopInputSchema = z
  .object({
    backgroundId: z
      .string()
      .min(1)
      .describe(
        "The id run_command returned for the background command to stop.",
      ),
  })
  .strict();
export type CommandStopInput = z.infer<typeof commandStopInputSchema>;
export const commandStopJsonSchema = zodToJsonSchema(commandStopInputSchema);
