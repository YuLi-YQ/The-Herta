import { AsyncLocalStorage } from "node:async_hooks";
import type { PermissionModeState, ToolContext } from "./types/tool.js";

const scope = new AsyncLocalStorage<
  Pick<ToolContext, "getPermissionMode" | "permissionProtectedPaths">
>();

export function permissionModeState(
  ctx?: ToolContext,
): PermissionModeState | undefined {
  const getter = ctx?.getPermissionMode ?? scope.getStore()?.getPermissionMode;
  if (!getter) return undefined;
  const state = getter();
  if (
    !state ||
    !["read-only", "workspace-edit", "full-access"].includes(state.mode) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1
  ) {
    return { mode: "read-only", revision: 1 };
  }
  return { mode: state.mode, revision: state.revision };
}

export function getCurrentPermissionProtectedPaths(): readonly string[] {
  return scope.getStore()?.permissionProtectedPaths ?? [];
}

export function getCurrentPermissionMode() {
  return permissionModeState()?.mode;
}

export function withPermissionMode<T>(
  ctx: Pick<ToolContext, "getPermissionMode" | "permissionProtectedPaths">,
  action: () => T,
): T {
  return ctx.getPermissionMode ? scope.run(ctx, action) : action();
}
