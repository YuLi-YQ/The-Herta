import { randomUUID } from "node:crypto";
import type {
  HertaTool,
  MemoryItem,
  MemoryKind,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { redactSecrets } from "../run-command/redactor.js";
import { memorySaveInputSchema, memorySaveJsonSchema } from "./schema.js";

export type { MemorySaveInput } from "./schema.js";

export interface MemorySaveData {
  id: string;
  kind: MemoryKind;
  text: string;
}

export function memorySaveTool(): HertaTool {
  return {
    name: "memory_save",
    schema(): ToolSchema {
      return {
        name: "memory_save",
        description:
          "Save an operational fact to project memory. Persists across sessions: saved facts are listed for you at the start of every later dispatch. Use for build/test commands, style preferences, repo facts, recurring mistakes, and lessons learned. Do NOT use for secrets, raw command output, transient task progress, or unrelated chatter.",
        inputSchema: memorySaveJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<MemorySaveData>> {
      const parsed = memorySaveInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {kind, text}",
          summary: "invalid input",
        };
      }
      const input = parsed.data;
      const redactedText = redactSecrets(input.text);
      const now = new Date().toISOString();
      const item: MemoryItem = {
        id: randomUUID(),
        scope: "repo",
        kind: input.kind,
        text: redactedText,
        sourceSession: ctx.sessionId,
        createdAt: now,
        lastSeen: now,
        confidence: 1.0,
      };
      await ctx.memory.save(item);
      return {
        ok: true,
        data: { id: item.id, kind: item.kind, text: redactedText },
        summary: `remembered: ${input.kind}`,
      };
    },
  };
}
