import type {
  HertaTool,
  RunCommandData,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { redactSecrets } from "./redactor.js";
import {
  commandOutputInputSchema,
  commandOutputJsonSchema,
  commandStopInputSchema,
  commandStopJsonSchema,
} from "./schema.js";

function invalidInput(msg: string, usage: string): ToolResult<RunCommandData> {
  return {
    ok: false,
    error: { code: "invalid_input", message: msg, retryable: false },
    suggestion: usage,
    summary: "invalid input",
  };
}

function notFound(id: string): ToolResult<RunCommandData> {
  return {
    ok: false,
    error: {
      code: "not_found",
      message: `no background command with id ${id} (it may have already been stopped)`,
      retryable: false,
    },
    summary: `no background command ${id}`,
  };
}

/** Read appended output from a managed background command (ADR 0025 slice 4). */
export function commandOutputTool(): HertaTool {
  return {
    name: "command_output",
    // Cursor-driven pure read (the caller owns sinceByte) — safe to run
    // concurrently with other read-only tools (ADR 0025 slice 5).
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "command_output",
        description:
          "Read new output from a background command started by run_command (runInBackground). Pass its backgroundId; sinceByte returns only output appended past that cursor (use the previous call's nextByte). Reports whether the process is still running or has exited.",
        inputSchema: commandOutputJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<RunCommandData>> {
      const parsed = commandOutputInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return invalidInput(
          formatInputIssues(parsed.error),
          "usage: {backgroundId, sinceByte?}",
        );
      }
      const { backgroundId, sinceByte = 0 } = parsed.data;
      const proc = ctx.bg.get(backgroundId);
      if (proc === undefined) return notFound(backgroundId);

      // The BackgroundProcess interface (core) is minimal; the tools-side
      // spawn class adds status()/readSince(). Feature-detect defensively.
      const p = proc as unknown as {
        readSince?: (n: number) => {
          text: string;
          nextByte: number;
          elidedBytes: number;
        };
        status?: () => {
          running: boolean;
          exitCode: number | null;
          signal: string | null;
        };
      };
      const slice = p.readSince?.(sinceByte) ?? {
        text: "",
        nextByte: sinceByte,
        elidedBytes: 0,
      };
      const st = p.status?.() ?? {
        running: proc.isRunning(),
        exitCode: null,
        signal: null,
      };
      const output = redactSecrets(slice.text);
      const elidedNote =
        slice.elidedBytes > 0
          ? ` (${slice.elidedBytes} earlier bytes rolled off the buffer)`
          : "";
      const stateWord = st.running
        ? "running"
        : `exited (code ${st.exitCode ?? "null"}${st.signal != null ? `, signal ${st.signal}` : ""})`;

      return {
        ok: true,
        data: {
          argv: proc.argv,
          cwd: ".",
          exitCode: st.exitCode,
          signal: st.signal,
          durationMs: 0,
          stdout: output,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutBytes: slice.text.length,
          stderrBytes: 0,
          logPath: "",
          timedOut: false,
          backgroundId,
          running: st.running,
          nextByte: slice.nextByte,
        } as RunCommandData & { nextByte: number },
        summary: `${backgroundId} ${stateWord}${elidedNote} — ${output.length} new chars`,
      };
    },
  };
}

/** Stop a managed background command (ADR 0025 slice 4). */
export function commandStopTool(): HertaTool {
  return {
    name: "command_stop",
    schema(): ToolSchema {
      return {
        name: "command_stop",
        description:
          "Stop a background command started by run_command (runInBackground), killing its whole process tree. Pass its backgroundId. Idempotent — stopping an already-exited command succeeds. (All background commands are stopped automatically when the task ends.)",
        inputSchema: commandStopJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<RunCommandData>> {
      const parsed = commandStopInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return invalidInput(
          formatInputIssues(parsed.error),
          "usage: {backgroundId}",
        );
      }
      const { backgroundId } = parsed.data;
      const proc = ctx.bg.get(backgroundId);
      if (proc === undefined) return notFound(backgroundId);

      const wasRunning = proc.isRunning();
      await proc.kill();
      return {
        ok: true,
        data: {
          argv: proc.argv,
          cwd: ".",
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutBytes: 0,
          stderrBytes: 0,
          logPath: "",
          timedOut: false,
          backgroundId,
          running: false,
        },
        summary: wasRunning
          ? `stopped background command ${backgroundId}`
          : `background command ${backgroundId} had already exited`,
      };
    },
  };
}
