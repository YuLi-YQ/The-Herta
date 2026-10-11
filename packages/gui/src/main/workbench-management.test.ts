// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionMetadata } from "@herta/app-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationMutation,
  SetWorkbenchPermissionInput,
} from "../shared/workbench-ipc.js";
import { createWorkbenchManagement } from "./workbench-management.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-management-"));
  roots.push(root);
  const profile = join(root, "profile"),
    workspace = join(root, "project");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "source.txt"), "unchanged");
  const sessions: SessionMetadata[] = ["active", "background"].map(
    (sessionId) => ({
      sessionId,
      workspaceRoot: workspace,
      backendWorkspace: workspace,
      startedAt: "2026-10-05",
      lastActivityAt: "2026-10-05",
    }),
  );
  let active: Session | null = {
    sessionId: "active",
    backendWorkspace: workspace,
    backendWorkspaceIsDefault: false,
    turnInFlight: false,
  } as Session;
  const closeActive = vi.fn(async () => {
    active = null;
  });
  const cleared = vi.fn();
  const deps = {
    profile,
    sessions: () => sessions,
    active: () => active,
    closeActive,
    cleared,
  };
  const management = createWorkbenchManagement(deps);
  management.navigation();
  return {
    root,
    profile,
    workspace,
    sessions,
    management,
    deps,
    closeActive,
    cleared,
    setActive: (value: Session | null) => {
      active = value;
    },
  };
}
describe("trusted workbench management with real profile files", () => {
  it("does not inherit an unrelated active temporary workspace marker", () => {
    const { management, workspace, setActive } = fixture();
    setActive({
      sessionId: "temporary",
      backendWorkspace: workspace,
      backendWorkspaceIsDefault: true,
    } as Session);
    const background = management.permissionFor("late-background", workspace);
    expect(
      management
        .navigation()
        .projects.find((p) => p.projectId === background.projectId)?.path,
    ).toBe(workspace);
    const temporary = management.permissionFor("temporary", workspace);
    expect(
      management
        .navigation()
        .projects.find((p) => p.projectId === temporary.projectId)?.path,
    ).toBe(null);
  });
  it("preserves background grants, increments active revision and persists across restart", () => {
    const { management, sessions, workspace, deps } = fixture();
    const old = management.permission();
    const persistedRevision = management.navigation().revision;
    const background = management.permissionFor("background");
    const next = management.setPermission({
      sessionId: "active",
      mode: "full-access",
      scope: "project",
      expectedRevision: old.revision,
      confirmFullAccess: true,
    });
    expect(next.mode).toBe("full-access");
    expect(management.navigation().revision).toBe(persistedRevision + 1);
    expect(next.revision).toBeGreaterThan(old.revision);
    expect(management.permissionFor("background")).toMatchObject({
      mode: "workspace-edit",
      revision: background.revision,
      source: "session",
    });
    expect(() =>
      management.setPermission({
        sessionId: "active",
        mode: "read-only",
        scope: "session",
        expectedRevision: old.revision,
      }),
    ).toThrow(/过期/);
    sessions.push({
      sessionId: "future",
      workspaceRoot: workspace,
      startedAt: "2026-10-05",
      lastActivityAt: "2026-10-05",
    });
    management.navigation();
    expect(management.permissionFor("future").mode).toBe("full-access");
    const restarted = createWorkbenchManagement(deps);
    expect(restarted.permission().mode).toBe("full-access");
    expect(restarted.permissionFor("background").mode).toBe("workspace-edit");
    const restricted = restarted.setPermission({
      sessionId: "active",
      mode: "read-only",
      scope: "session",
      expectedRevision: restarted.permission().revision,
    });
    expect(() =>
      restarted.setPermission({
        sessionId: "active",
        mode: null,
        scope: "session",
        expectedRevision: restricted.revision,
      }),
    ).toThrow(/明确确认/);
    expect(
      restarted.setPermission({
        sessionId: "active",
        mode: null,
        scope: "session",
        expectedRevision: restricted.revision,
        confirmFullAccess: true,
      }).mode,
    ).toBe("full-access");
  });
  it("rejects forged ownership and malformed input without mutation", async () => {
    const { management } = fixture();
    const before = management.navigation();
    const permission = management.permission();
    for (const input of [
      {
        sessionId: "background",
        mode: "full-access",
        scope: "session",
        expectedRevision: permission.revision,
        confirmFullAccess: true,
      },
      { ...permission, scope: "session" },
      {
        sessionId: "active",
        mode: "full-access",
        scope: "session",
        expectedRevision: permission.revision,
        confirmFullAccess: "yes",
      },
      Object.assign(Object.create({ mode: "full-access" }), {
        sessionId: "active",
        scope: "session",
        expectedRevision: permission.revision,
        confirmFullAccess: true,
      }),
    ])
      expect(() =>
        management.setPermission(input as SetWorkbenchPermissionInput),
      ).toThrow();
    for (const input of [
      { kind: "__proto__" },
      { kind: "create-project" },
      { kind: "remove-project", projectId: before.projects[0]!.projectId },
      { kind: "recycle-task", sessionId: "active", mode: "full-access" },
    ])
      await expect(
        management.update(input as NavigationMutation),
      ).rejects.toThrow();
    expect(management.navigation()).toEqual(before);
  });
  it.each([
    "recycle-task",
    "remove-project",
  ] as const)("keeps records visible when %s cannot close", async (kind) => {
    const { management, closeActive, cleared, workspace } = fixture();
    const before = management.navigation();
    closeActive.mockRejectedValueOnce(new Error("close failed"));
    const input: NavigationMutation =
      kind === "recycle-task"
        ? { kind, sessionId: "active" }
        : {
            kind,
            projectId: before.projects[0]!.projectId,
            recycleTasks: true,
          };
    await expect(management.update(input)).rejects.toThrow("close failed");
    expect(management.navigation()).toEqual(before);
    expect(cleared).not.toHaveBeenCalled();
    expect(readFileSync(join(workspace, "source.txt"), "utf8")).toBe(
      "unchanged",
    );
  });
  it("blocks running removal and soft-recycles idle tasks without touching code", async () => {
    const { management, setActive, workspace, closeActive, deps } = fixture();
    setActive({
      sessionId: "active",
      backendWorkspace: workspace,
      turnInFlight: true,
    } as Session);
    await expect(
      management.update({ kind: "recycle-task", sessionId: "active" }),
    ).rejects.toThrow(/停止/);
    expect(closeActive).not.toHaveBeenCalled();
    setActive({
      sessionId: "active",
      backendWorkspace: workspace,
      turnInFlight: false,
    } as Session);
    await management.update({ kind: "recycle-task", sessionId: "active" });
    expect(
      management.navigation().tasks.find((t) => t.sessionId === "active")
        ?.recycled,
    ).toBe(true);
    const restarted = createWorkbenchManagement(deps);
    expect(
      restarted.navigation().tasks.find((t) => t.sessionId === "active")
        ?.recycled,
    ).toBe(true);
    await expect(restarted.update({ kind: "restore-task", sessionId: "active" } as never)).rejects.toThrow("无效字段");
    expect(readFileSync(join(workspace, "source.txt"), "utf8")).toBe(
      "unchanged",
    );
  });
});
