import type { Session, SessionMetadata } from "@herta/app-server";
import type { PermissionModeState } from "@herta/core";
import type {
  NavigationMutation,
  SetWorkbenchPermissionInput,
  WorkbenchPermission,
} from "../shared/workbench-ipc.js";
import { ProjectNavigationStore } from "./project-navigation.js";

interface Dependencies {
  profile: string;
  sessions: () => SessionMetadata[];
  active: () => Session | null;
  closeActive: () => Promise<void>;
  cleared: () => void;
}
const modes = new Set(["read-only", "workspace-edit", "full-access"]);
function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
/** GUI-owned navigation and grants, never loaded from model-controlled project files. */
export function createWorkbenchManagement(deps: Dependencies) {
  let store: ProjectNavigationStore | undefined;
  const epochs = new Map<string, PermissionModeState>();
  function storage() {
    store ??= new ProjectNavigationStore(deps.profile);
    return store;
  }
  function navigation() {
    store ??= new ProjectNavigationStore(deps.profile);
    return store.syncSessions(
      deps.sessions().map((s) => ({
        sessionId: s.sessionId,
        workspace: s.backendWorkspace ?? s.workspaceRoot,
        isDefault: s.backendWorkspaceIsDefault ?? false,
      })),
    );
  }
  function permissionFor(
    sessionId: string,
    backendWorkspace?: string,
  ): WorkbenchPermission {
    let view = store?.view() ?? navigation();
    let task = view.tasks.find((t) => t.sessionId === sessionId);
    if (!task && backendWorkspace) {
      const active = deps.active();
      const metadata = deps.sessions().find((s) => s.sessionId === sessionId);
      view = storage().syncSessions([
        {
          sessionId,
          workspace: backendWorkspace,
          isDefault:
            active?.sessionId === sessionId
              ? active.backendWorkspaceIsDefault ||
                (metadata?.backendWorkspaceIsDefault ?? false)
              : (metadata?.backendWorkspaceIsDefault ?? false),
        },
      ]);
      task = view.tasks.find((t) => t.sessionId === sessionId);
    }
    const project = view.projects.find((p) => p.projectId === task?.projectId);
    const mode =
      task?.permissionMode ?? project?.permissionMode ?? "workspace-edit";
    const previous = epochs.get(sessionId);
    const state = {
      mode,
      revision: previous
        ? previous.revision + (previous.mode === mode ? 0 : 1)
        : view.revision,
    };
    epochs.set(sessionId, state);
    return {
      ...state,
      sessionId,
      projectId: project?.projectId ?? null,
      source: task?.permissionMode
        ? "session"
        : project
          ? "project"
          : "default",
      projectMode: project?.permissionMode ?? "workspace-edit",
    };
  }
  function permission(): WorkbenchPermission {
    const active = deps.active();
    return active
      ? permissionFor(active.sessionId, active.backendWorkspace)
      : {
          sessionId: null,
          projectId: null,
          source: "default",
          projectMode: "workspace-edit",
          mode: "workspace-edit",
          revision: 0,
        };
  }
  function setPermission(
    input: SetWorkbenchPermissionInput,
  ): WorkbenchPermission {
    const current = permission();
    if (
      !plainObject(input) ||
      Object.keys(input).some(
        (k) =>
          ![
            "sessionId",
            "mode",
            "scope",
            "expectedRevision",
            "confirmFullAccess",
          ].includes(k),
      ) ||
      input.sessionId !== current.sessionId ||
      !current.sessionId ||
      input.expectedRevision !== current.revision ||
      !Number.isSafeInteger(input.expectedRevision) ||
      (input.confirmFullAccess !== undefined &&
        typeof input.confirmFullAccess !== "boolean") ||
      (input.mode !== null && !modes.has(input.mode)) ||
      !["session", "project"].includes(input.scope)
    )
      throw new Error("权限选择已过期或不属于当前任务，请重新选择。");
    const requestedMode = input.mode ?? current.projectMode;
    if (
      requestedMode === "full-access" &&
      current.mode !== "full-access" &&
      input.confirmFullAccess !== true
    )
      throw new Error("完全访问需要明确确认其操作范围。");
    if (input.scope === "project") {
      if (!current.projectId || input.mode === null)
        throw new Error("项目权限模式无效。");
      // Existing background tasks keep the grant they already had. Project choice
      // applies to this active task and future tasks, never silently elevates old ones.
      navigation();
      storage().setProjectPermissionForActive(
        current.projectId,
        current.sessionId,
        input.mode,
      );
    } else storage().setSessionPermission(current.sessionId, input.mode);
    const next = permission();
    if (next.mode !== current.mode && next.revision === current.revision)
      throw new Error("权限修订未更新。");
    return next;
  }
  async function update(input: NavigationMutation) {
    if (!plainObject(input)) throw new Error("导航操作无效。");
    navigation();
    const allowed: Record<string, string[]> = {
      "create-project": ["kind", "path"],
      "rename-project": ["kind", "projectId", "name"],
      "relocate-project": ["kind", "projectId", "path"],
      "pin-project": ["kind", "projectId", "pinned"],
      "expand-project": ["kind", "projectId", "expanded"],
      "remove-project": ["kind", "projectId", "recycleTasks"],
      "pin-task": ["kind", "sessionId", "pinned"],
      "recycle-task": ["kind", "sessionId"],
    };
    const fields = Object.hasOwn(allowed, input.kind)
      ? allowed[input.kind]
      : undefined;
    if (
      !fields ||
      Object.keys(input).some((k) => !fields.includes(k)) ||
      fields.some((k) => !Object.hasOwn(input, k))
    )
      throw new Error("导航操作包含无效字段。");
    const view = navigation();
    const active = deps.active();
    const affectsActive =
      active &&
      ((input.kind === "recycle-task" &&
        input.sessionId === active.sessionId) ||
        ((input.kind === "remove-project" ||
          input.kind === "relocate-project") &&
          view.tasks.some(
            (t) =>
              t.sessionId === active.sessionId &&
              t.projectId === input.projectId,
          )));
    if (affectsActive && active.turnInFlight)
      throw new Error("请先停止正在运行的任务，再移除或删除。");
    switch (input.kind) {
      case "create-project":
        return storage().createProject(input.path);
      case "rename-project":
        return storage().renameProject(input.projectId, input.name);
      case "relocate-project":
        // Navigation/future tasks only; existing sessions retain their own cwd.
        return storage().relocateProject(input.projectId, input.path);
      case "pin-project":
        return storage().pinProject(input.projectId, input.pinned);
      case "expand-project":
        return storage().expandProject(input.projectId, input.expanded);
      case "remove-project": {
        if (typeof input.recycleTasks !== "boolean")
          throw new Error("导航状态无效。");
        if (affectsActive && input.recycleTasks) {
          await deps.closeActive();
          deps.cleared();
        }
        return storage().removeProject(input.projectId, {
          recycleTasks: input.recycleTasks,
        });
      }
      case "pin-task":
        return storage().pinTask(input.sessionId, input.pinned);
      case "recycle-task": {
        // Close before persistence: a failed close must leave records recoverable
        // and visible, rather than recycling a still-active task.
        if (affectsActive) {
          await deps.closeActive();
          deps.cleared();
        }
        return storage().recycleTask(input.sessionId);
      }
    }
  }
  return { navigation, permission, permissionFor, setPermission, update };
}
