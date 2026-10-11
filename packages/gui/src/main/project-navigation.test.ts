// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectNavigationStore } from "./project-navigation.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-navigation-"));
  roots.push(root);
  const storage = join(root, "profile");
  const a = join(root, "a", "same");
  const b = join(root, "b", "same");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "source.txt"), "unchanged");
  return { root, storage, a, b, store: new ProjectNavigationStore(storage) };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("project navigation real-file persistence", () => {
  it("atomically updates the active project default while freezing old background inheritance", () => {
    const { store, a, b, storage } = fixture();
    store.syncSessions([
      { sessionId: "active", workspace: a },
      { sessionId: "background", workspace: a },
      { sessionId: "explicit", workspace: a },
      { sessionId: "other", workspace: b },
    ]);
    const projectId = store
      .view()
      .tasks.find((t) => t.sessionId === "active")!.projectId;
    store.setSessionPermission("active", "read-only");
    store.setSessionPermission("explicit", "read-only");
    const before = store.view();
    expect(() =>
      store.setProjectPermissionForActive(projectId, "other", "full-access"),
    ).toThrow();
    expect(store.view()).toEqual(before);
    const next = store.setProjectPermissionForActive(
      projectId,
      "active",
      "full-access",
    );
    expect(next.revision).toBe(before.revision + 1);
    expect(
      next.tasks.find((t) => t.sessionId === "active")?.permissionMode,
    ).toBeNull();
    expect(
      next.tasks.find((t) => t.sessionId === "background")?.permissionMode,
    ).toBe("workspace-edit");
    expect(
      next.tasks.find((t) => t.sessionId === "explicit")?.permissionMode,
    ).toBe("read-only");
    expect(new ProjectNavigationStore(storage).view()).toEqual(next);
    store.syncSessions([{ sessionId: "future", workspace: a }]);
    expect(
      store.view().tasks.find((t) => t.sessionId === "future")?.permissionMode,
    ).toBeNull();
    expect(
      store.view().projects.find((p) => p.projectId === projectId)
        ?.permissionMode,
    ).toBe("full-access");
  });
  it("relocates a renamed real directory while retaining identity, tasks and permissions across restart", () => {
    const { store, storage, root, a } = fixture();
    store.syncSessions([{ sessionId: "old-task", workspace: a }]);
    const projectId = store.view().projects[0]!.projectId;
    store.renameProject(projectId, "星图");
    store.pinProject(projectId, true);
    store.pinTask("old-task", true);
    store.setProjectPermission(projectId, "read-only");
    store.setSessionPermission("old-task", "full-access");
    const before = store.view();
    const moved = join(root, "renamed");
    renameSync(a, moved);
    store.relocateProject(projectId, join(moved, "..", "renamed"));
    const restart = new ProjectNavigationStore(storage);
    expect(restart.view().projects[0]).toEqual({
      ...before.projects[0],
      path: moved,
      name: "renamed",
    });
    expect(restart.view().tasks).toEqual(before.tasks);
    restart.syncSessions([
      { sessionId: "old-task", workspace: a },
      { sessionId: "new-task", workspace: moved },
    ]);
    expect(restart.view().projects).toHaveLength(1);
    expect(restart.view().tasks.every((t) => t.projectId === projectId)).toBe(
      true,
    );
    expect(readFileSync(join(moved, "source.txt"), "utf8")).toBe("unchanged");
  });
  it("keeps known project identity after explicitly updating an old session workspace and reads the desired path without saving", () => {
    const { store, storage, root, a } = fixture();
    store.syncSessions([{ sessionId: "old-task", workspace: a }]);
    const projectId = store.view().projects[0]!.projectId;
    store.pinTask("old-task", true);
    store.setSessionPermission("old-task", "read-only");
    const moved = join(root, "relocated");
    renameSync(a, moved);
    store.relocateProject(projectId, moved);
    const before = store.view();
    const diskBefore = readFileSync(
      join(storage, "project-navigation.json"),
      "utf8",
    );
    expect(store.desiredPath("old-task")).toBe(moved);
    expect(readFileSync(join(storage, "project-navigation.json"), "utf8")).toBe(
      diskBefore,
    );
    // The caller has explicitly changed this session's actual workspace; syncing does not reassign it.
    expect(
      store.syncSessions([{ sessionId: "old-task", workspace: moved }]),
    ).toEqual(before);
    const restarted = new ProjectNavigationStore(storage);
    expect(restarted.desiredPath("old-task")).toBe(moved);
    expect(restarted.view().tasks[0]).toMatchObject({
      projectId,
      pinned: true,
      permissionMode: "read-only",
    });
    restarted.recycleTask("old-task");
    expect(restarted.desiredPath("old-task")).toBeNull();
    restarted.restoreTask("old-task");
    restarted.removeProject(projectId);
    expect(restarted.desiredPath("old-task")).toBeNull();
    expect(() => restarted.desiredPath("missing")).toThrow(/任务不存在/);
    expect(readFileSync(join(moved, "source.txt"), "utf8")).toBe("unchanged");
  });
  it("rejects relocation into another project, missing path, file or temporary workspace without mutation", () => {
    const { store, a, b, root, storage } = fixture();
    store.syncSessions([
      { sessionId: "a", workspace: a },
      { sessionId: "b", workspace: b },
      { sessionId: "temp", workspace: a, isDefault: true },
    ]);
    const before = store.view();
    const projectId = before.tasks.find((t) => t.sessionId === "a")!.projectId;
    expect(() => store.relocateProject(projectId, b)).toThrow(/其他项目/);
    expect(() =>
      store.relocateProject(projectId, join(root, "absent")),
    ).toThrow();
    expect(() =>
      store.relocateProject(projectId, join(a, "source.txt")),
    ).toThrow();
    expect(() =>
      store.relocateProject(
        before.projects.find((p) => p.path === null)!.projectId,
        a,
      ),
    ).toThrow(/临时工作区/);
    expect(new ProjectNavigationStore(storage).view()).toEqual(before);
  });
  it("migrates metadata once, separates equal names and groups managed sessions", () => {
    const { store, storage, a, b } = fixture();
    const sessions = [
      { sessionId: "task-a", workspace: a },
      { sessionId: "task-b", workspace: b },
      { sessionId: "managed", workspace: a, isDefault: true },
    ];
    const first = store.syncSessions(sessions);
    expect(first.projects).toHaveLength(3);
    expect(first.projects.filter((p) => p.name === "same")).toHaveLength(2);
    expect(first.projects.find((p) => p.path === null)?.name).toBe(
      "临时工作区",
    );
    expect(store.syncSessions(sessions)).toEqual(first);
    expect(new ProjectNavigationStore(storage).view()).toEqual(first);
  });
  it("persists aliases, pin order, collapse and permission inheritance independently", () => {
    const { store, storage, a, b } = fixture();
    store.syncSessions([
      { sessionId: "a", workspace: a },
      { sessionId: "b", workspace: b },
      { sessionId: "c", workspace: a },
    ]);
    const project = store
      .view()
      .tasks.find((t) => t.sessionId === "a")!.projectId;
    store.renameProject(project, "星图");
    store.pinProject(project, true);
    store.expandProject(project, false);
    store.pinTask("c", true);
    store.pinTask("a", true);
    store.setProjectPermission(project, "read-only");
    store.setSessionPermission("a", "full-access");
    const next = new ProjectNavigationStore(storage).view();
    expect(next.projects[0]).toMatchObject({
      alias: "星图",
      pinned: true,
      expanded: false,
      permissionMode: "read-only",
    });
    expect(
      next.tasks.filter((t) => t.projectId === project).map((t) => t.sessionId),
    ).toEqual(["c", "a"]);
    expect(next.tasks.find((t) => t.sessionId === "a")?.permissionMode).toBe(
      "full-access",
    );
    expect(
      next.tasks.find((t) => t.sessionId === "c")?.permissionMode,
    ).toBeNull();
  });
  it("removes navigation without touching source/history and never auto-restores removed projects", () => {
    const { store, storage, a } = fixture();
    const transcript = join(storage, "task.jsonl");
    store.syncSessions([{ sessionId: "a", workspace: a }]);
    writeFileSync(transcript, "history");
    const p = store.view().projects[0]!.projectId;
    store.removeProject(p);
    const revision = store.view().revision;
    store.syncSessions([
      { sessionId: "a", workspace: a },
      { sessionId: "b", workspace: a },
    ]);
    expect(store.view().projects[0]!.removed).toBe(true);
    expect(store.view().revision).toBe(revision + 1);
    expect(store.view().tasks.every((t) => !t.recycled)).toBe(true);
    store.removeProject(p, { recycleTasks: true });
    expect(store.view().tasks.filter((t) => t.recycled)).toHaveLength(2);
    const reboot = new ProjectNavigationStore(storage);
    reboot.restoreTask("a");
    expect(reboot.view().projects[0]!.removed).toBe(false);
    expect(reboot.view().tasks.find((t) => t.sessionId === "b")?.recycled).toBe(
      true,
    );
    expect(readFileSync(transcript, "utf8")).toBe("history");
    expect(readFileSync(join(a, "source.txt"), "utf8")).toBe("unchanged");
  });
  it("normalizes aliases and accepts missing legacy paths but rejects creating them", () => {
    const { store, root, a } = fixture();
    store.syncSessions([
      { sessionId: "a", workspace: a },
      { sessionId: "alias", workspace: join(a, "..", "same") },
      { sessionId: "old", workspace: join(root, "gone") },
    ]);
    expect(store.view().projects).toHaveLength(2);
    expect(() => store.createProject(join(root, "absent"))).toThrow();
    expect(() => store.createProject(join(a, "source.txt"))).toThrow();
  });
  it("rejects hostile input and corrupt storage without silently replacing it", () => {
    const { store, storage, a } = fixture();
    store.syncSessions([{ sessionId: "a", workspace: a }]);
    const file = join(storage, "project-navigation.json");
    const before = readFileSync(file, "utf8");
    expect(() =>
      store.syncSessions([{ sessionId: "../escape", workspace: a }]),
    ).toThrow();
    expect(() =>
      store.renameProject(store.view().projects[0]!.projectId, "\n"),
    ).toThrow();
    expect(() =>
      store.removeProject(
        store.view().projects[0]!.projectId,
        JSON.parse('{"__proto__":true}'),
      ),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, '{"schemaVersion":999}');
    expect(() => new ProjectNavigationStore(storage)).toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"schemaVersion":999}');
  });
  it("keeps state and disk unchanged on invalid permissions and inherited input", () => {
    const { store, a, storage } = fixture();
    store.syncSessions([{ sessionId: "a", workspace: a }]);
    const before = store.view();
    expect(() =>
      store.setProjectPermission(
        before.projects[0]!.projectId,
        "model-granted" as never,
      ),
    ).toThrow();
    expect(() =>
      store.syncSessions([
        Object.create({ sessionId: "inherited", workspace: a }),
      ]),
    ).toThrow();
    store.pinTask("a", true);
    const pinned = store.view();
    expect(store.pinTask("a", true)).toEqual(pinned);
    store.recycleTask("a");
    const recycled = new ProjectNavigationStore(storage);
    expect(recycled.view().tasks[0]?.recycled).toBe(true);
    recycled.forgetTask("a");
    expect(recycled.view().tasks).toEqual([]);
    expect(recycled.view().projects).toHaveLength(1);
  });
});
