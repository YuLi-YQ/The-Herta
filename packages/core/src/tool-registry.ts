import { permissionModeState, withPermissionMode } from "./permission-mode.js";
import type {
  HertaTool,
  OutputFn,
  ProgressFn,
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "./types/tool.js";

export interface ToolRegistry {
  register(tool: HertaTool): void;
  get(name: string): HertaTool | undefined;
  list(): HertaTool[];
  run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
    output?: OutputFn,
  ): Promise<ToolResult>;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, HertaTool>();

  register(tool: HertaTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool by name; a name not registered is a no-op. The toolset
   *  follows the environment per session (ADR 0067): the wiring unmounts the
   *  git tools when the workspace moves out of a repository. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): HertaTool | undefined {
    return this.tools.get(name);
  }

  list(): HertaTool[] {
    return [...this.tools.values()];
  }

  async run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
    output?: OutputFn,
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: "unknown_tool",
          message: `tool not registered: ${call.tool}`,
          retryable: false,
        },
        summary: `unknown tool: ${call.tool}`,
      };
    }
    if (
      permissionModeState(ctx)?.mode === "read-only" &&
      !tool.readOnly &&
      !["run_command", "bash", "command_stop", "report_finding"].includes(
        call.tool,
      ) &&
      !(
        call.tool === "str_replace_editor" &&
        (call.input as { command?: unknown })?.command === "view"
      )
    ) {
      return {
        ok: false,
        error: {
          code: "permission_read_only",
          message: "Read-only mode forbids this mutation.",
          retryable: false,
        },
        summary: "read-only mode",
      };
    }
    const state = permissionModeState(ctx);
    const checkedRevision = ctx.permissionCheckedCalls?.get(call.id);
    if (
      state &&
      checkedRevision !== undefined &&
      checkedRevision !== state.revision
    )
      return {
        ok: false,
        error: {
          code: "permission_mode_changed",
          message:
            "Permission mode changed before dispatch; explicitly continue with a new request.",
          retryable: false,
        },
        summary: "permission changed; no tool executed",
      };
    const granted =
      state?.mode === "workspace-edit" &&
      ctx.approvedPermissionCalls?.get(call.id) === state.revision;
    const runContext = granted
      ? {
          ...ctx,
          getPermissionMode: () => {
            const current = permissionModeState(ctx);
            return current?.mode === "workspace-edit" &&
              current.revision === state.revision
              ? { ...current, mode: "full-access" as const }
              : (current ?? { mode: "read-only" as const, revision: 1 });
          },
        }
      : ctx;
    try {
      return await withPermissionMode(runContext, () =>
        tool.run(call, runContext, progress, output),
      );
    } finally {
      ctx.approvedPermissionCalls?.delete(call.id);
      ctx.permissionCheckedCalls?.delete(call.id);
    }
  }
}
