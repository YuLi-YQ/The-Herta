import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import type {
  NavigationPermissionMode,
  NavigationProject,
  NavigationSession,
  NavigationTask,
  ProjectNavigationView,
} from "../shared/workbench-ipc.js";

export type {
  NavigationPermissionMode,
  NavigationProject,
  NavigationSession,
  NavigationTask,
  ProjectNavigationView,
} from "../shared/workbench-ipc.js";

const modes = new Set(["read-only", "workspace-edit", "full-access"]);
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  )
    throw new Error("导航 ID 无效。");
  return value;
}
function label(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 120 ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error("项目名称无效。");
  return value.trim();
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("导航状态无效。");
  return value;
}
function mode(value: unknown): NavigationPermissionMode {
  if (typeof value !== "string" || !modes.has(value))
    throw new Error("权限模式无效。");
  return value as NavigationPermissionMode;
}
function canonical(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32) ||
    !isAbsolute(value)
  )
    throw new Error("项目必须使用绝对路径。");
  const path = normalize(resolve(value));
  return existsSync(path) ? realpathSync.native(path) : path;
}
function pathKey(path: string | null): string {
  return path === null
    ? "temporary"
    : process.platform === "win32"
      ? path.toLowerCase()
      : path;
}
function keys(
  value: unknown,
  expected: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).some((key) => !expected.includes(key))
  )
    throw new Error("导航存储格式无效。");
}
function order(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("置顶顺序无效。");
  return value as number;
}

/** Navigation only: never removes or edits project files, transcripts or credentials. */
export class ProjectNavigationStore {
  private state: ProjectNavigationView = {
    schemaVersion: 1,
    revision: 0,
    projects: [],
    tasks: [],
  };
  private readonly file: string;
  constructor(storageDir: string) {
    if (!isAbsolute(storageDir))
      throw new Error("导航存储目录必须为绝对路径。");
    this.file = join(storageDir, "project-navigation.json");
    if (existsSync(this.file)) {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      keys(raw, ["schemaVersion", "revision", "projects", "tasks"]);
      if (
        raw.schemaVersion !== 1 ||
        !Array.isArray(raw.projects) ||
        !Array.isArray(raw.tasks)
      )
        throw new Error("导航存储版本无效。");
      const projects = raw.projects.map((value) => {
        keys(value, [
          "projectId",
          "path",
          "name",
          "alias",
          "pinned",
          "pinOrder",
          "expanded",
          "removed",
          "permissionMode",
        ]);
        return {
          projectId: id(value.projectId),
          path: value.path === null ? null : canonical(value.path),
          name: label(value.name),
          alias: value.alias === null ? null : label(value.alias),
          pinned: flag(value.pinned),
          pinOrder: order(value.pinOrder),
          expanded: flag(value.expanded),
          removed: flag(value.removed),
          permissionMode: mode(value.permissionMode),
        };
      });
      const tasks = raw.tasks.map((value) => {
        keys(value, [
          "sessionId",
          "projectId",
          "pinned",
          "pinOrder",
          "recycled",
          "permissionMode",
        ]);
        return {
          sessionId: id(value.sessionId),
          projectId: id(value.projectId),
          pinned: flag(value.pinned),
          pinOrder: order(value.pinOrder),
          recycled: flag(value.recycled),
          permissionMode:
            value.permissionMode === null ? null : mode(value.permissionMode),
        };
      });
      if (
        new Set(projects.map((p) => p.projectId)).size !== projects.length ||
        new Set(tasks.map((t) => t.sessionId)).size !== tasks.length ||
        tasks.some((t) => !projects.some((p) => p.projectId === t.projectId))
      )
        throw new Error("导航关系无效。");
      this.state = {
        schemaVersion: 1,
        revision: order(raw.revision),
        projects,
        tasks,
      };
    }
  }
  view(): ProjectNavigationView {
    const copy = structuredClone(this.state);
    copy.projects.sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || a.pinOrder - b.pinOrder,
    );
    copy.tasks.sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || a.pinOrder - b.pinOrder,
    );
    return copy;
  }
  /** Read-only navigation hint; callers must obtain user action before changing a session workspace. */
  desiredPath(sessionId: string): string | null {
    const task = this.task(this.state, sessionId);
    const project = this.project(this.state, task.projectId);
    return project.removed || task.recycled ? null : project.path;
  }
  private commit(
    change: (next: ProjectNavigationView) => void,
  ): ProjectNavigationView {
    const next = structuredClone(this.state);
    change(next);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return this.view();
    next.revision += 1;
    mkdirSync(resolve(this.file, ".."), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temp, this.file);
      this.state = next;
    } finally {
      rmSync(temp, { force: true });
    }
    return this.view();
  }
  private project(
    state: ProjectNavigationView,
    projectId: string,
  ): NavigationProject {
    const found = state.projects.find((p) => p.projectId === id(projectId));
    if (!found) throw new Error("项目不存在。");
    return found;
  }
  private task(
    state: ProjectNavigationView,
    sessionId: string,
  ): NavigationTask {
    const found = state.tasks.find((t) => t.sessionId === id(sessionId));
    if (!found) throw new Error("任务不存在。");
    return found;
  }
  private ensureProject(
    state: ProjectNavigationView,
    path: string | null,
  ): NavigationProject {
    let found = state.projects.find((p) => pathKey(p.path) === pathKey(path));
    if (!found) {
      found = {
        projectId: randomUUID(),
        path,
        name: path === null ? "临时工作区" : basename(path) || path,
        alias: null,
        pinned: false,
        pinOrder: 0,
        expanded: true,
        removed: false,
        permissionMode: "workspace-edit",
      };
      state.projects.push(found);
    }
    return found;
  }
  syncSessions(sessions: NavigationSession[]): ProjectNavigationView {
    if (!Array.isArray(sessions) || sessions.length > 100000)
      throw new Error("会话列表无效。");
    const validated = sessions.map((s) => {
      keys(s, ["sessionId", "workspace", "title", "isDefault"]);
      if (s.isDefault !== undefined) flag(s.isDefault);
      return {
        sessionId: id(s.sessionId),
        path: s.isDefault ? null : canonical(s.workspace),
      };
    });
    return this.commit((state) => {
      for (const s of validated) {
        if (state.tasks.some((t) => t.sessionId === s.sessionId)) continue;
        const project = this.ensureProject(state, s.path);
        state.tasks.push({
          sessionId: s.sessionId,
          projectId: project.projectId,
          pinned: false,
          pinOrder: 0,
          recycled: false,
          permissionMode: null,
        });
      }
    });
  }
  createProject(path: string | null): ProjectNavigationView {
    const clean = path === null ? null : canonical(path);
    if (
      clean !== null &&
      (!existsSync(clean) || !statSync(clean).isDirectory())
    )
      throw new Error("项目目录不存在。");
    return this.commit((s) => {
      this.ensureProject(s, clean).removed = false;
    });
  }
  renameProject(
    projectId: string,
    alias: string | null,
  ): ProjectNavigationView {
    const clean = alias === null ? null : label(alias);
    return this.commit((s) => {
      this.project(s, projectId).alias = clean;
    });
  }
  /** Changes navigation/new-task location only; existing session workspaces stay untouched. */
  relocateProject(projectId: string, path: string): ProjectNavigationView {
    const clean = canonical(path);
    if (!existsSync(clean) || !statSync(clean).isDirectory())
      throw new Error("项目目录不存在。");
    return this.commit((state) => {
      const project = this.project(state, projectId);
      if (project.path === null) throw new Error("临时工作区不能重新定位。");
      if (
        state.projects.some(
          (p) =>
            p.projectId !== projectId && pathKey(p.path) === pathKey(clean),
        )
      )
        throw new Error("该目录已属于其他项目。");
      project.path = clean;
      project.name = basename(clean) || clean;
    });
  }
  pinProject(projectId: string, pinned: boolean): ProjectNavigationView {
    flag(pinned);
    return this.commit((s) => {
      const p = this.project(s, projectId);
      if (p.pinned === pinned) return;
      p.pinned = pinned;
      p.pinOrder = pinned
        ? Math.max(0, ...s.projects.map((v) => v.pinOrder)) + 1
        : 0;
    });
  }
  expandProject(projectId: string, expanded: boolean): ProjectNavigationView {
    flag(expanded);
    return this.commit((s) => {
      this.project(s, projectId).expanded = expanded;
    });
  }
  setProjectPermission(
    projectId: string,
    permission: NavigationPermissionMode,
  ): ProjectNavigationView {
    mode(permission);
    return this.commit((s) => {
      this.project(s, projectId).permissionMode = permission;
    });
  }
  setSessionPermission(
    sessionId: string,
    permission: NavigationPermissionMode | null,
  ): ProjectNavigationView {
    if (permission !== null) mode(permission);
    return this.commit((s) => {
      this.task(s, sessionId).permissionMode = permission;
    });
  }
  /** One atomic save: apply a project default without upgrading existing background tasks. */
  setProjectPermissionForActive(
    projectId: string,
    sessionId: string,
    permission: NavigationPermissionMode,
  ): ProjectNavigationView {
    mode(permission);
    return this.commit((state) => {
      const project = this.project(state, projectId);
      const active = this.task(state, sessionId);
      if (active.projectId !== project.projectId)
        throw new Error("活动任务不属于该项目。");
      for (const task of state.tasks)
        if (
          task.projectId === project.projectId &&
          task.sessionId !== sessionId &&
          task.permissionMode === null
        )
          task.permissionMode = project.permissionMode;
      project.permissionMode = permission;
      active.permissionMode = null;
    });
  }
  pinTask(sessionId: string, pinned: boolean): ProjectNavigationView {
    flag(pinned);
    return this.commit((s) => {
      const t = this.task(s, sessionId);
      if (t.pinned === pinned) return;
      t.pinned = pinned;
      t.pinOrder = pinned
        ? Math.max(
            0,
            ...s.tasks
              .filter((v) => v.projectId === t.projectId)
              .map((v) => v.pinOrder),
          ) + 1
        : 0;
    });
  }
  recycleTask(sessionId: string): ProjectNavigationView {
    return this.commit((s) => {
      this.task(s, sessionId).recycled = true;
    });
  }
  restoreTask(sessionId: string): ProjectNavigationView {
    return this.commit((s) => {
      const t = this.task(s, sessionId);
      t.recycled = false;
      this.project(s, t.projectId).removed = false;
    });
  }
  removeProject(
    projectId: string,
    options: { recycleTasks?: boolean } = {},
  ): ProjectNavigationView {
    keys(options, ["recycleTasks"]);
    if (options.recycleTasks !== undefined) flag(options.recycleTasks);
    return this.commit((s) => {
      this.project(s, projectId).removed = true;
      if (options.recycleTasks)
        for (const t of s.tasks)
          if (t.projectId === projectId) t.recycled = true;
    });
  }
  restoreProject(projectId: string): ProjectNavigationView {
    return this.commit((s) => {
      this.project(s, projectId).removed = false;
    });
  }
  /** Call only after the host has confirmed permanent record deletion. */
  forgetTask(sessionId: string): ProjectNavigationView {
    id(sessionId);
    return this.commit((s) => {
      s.tasks = s.tasks.filter((t) => t.sessionId !== sessionId);
    });
  }
}
