import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCommandRuleStore, type PermissionModeState } from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionHost } from "./types.js";
import type { WorkspaceOperationContext } from "./workspace-operation.js";

const folders: string[] = [], hosts: SessionHost[] = [], releases: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herta-workspace-operation-")); folders.push(root);
  let permission: PermissionModeState = { mode: "workspace-edit", revision: 1 };
  const resolveTurn = vi.fn(async () => { throw new Error("This synthetic test must never invoke a model."); });
  const config: AppServerConfig = {
    workspaceRoot: root, transcriptDir: join(root, ".herta", "transcript", "v2"), projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"), narrativeDir: join(root, ".herta", "narrative"), dream: { enabled: false },
    providers: { deepseekApiKey: "", actorModel: "unused", backendModel: "unused", routerModel: "unused" },
    neutralProviders: { resolveTurn }, getPermissionMode: () => permission,
  };
  const host = createSessionHost(config); hosts.push(host);
  return { root, host, resolveTurn, setPermission: (next: PermissionModeState) => { permission = next; } };
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const host of hosts.splice(0)) await host.closeActiveSession();
  for (const root of folders.splice(0)) await removeTmpDir(root);
});

describe("actual Session host workspace operations", () => {
  it("plugin command permission always presents an actual overlay despite full access, trust, rules and persistence requests", async () => {
    const f = fixture(), session = await f.host.createSession({ backendWorkspace: f.root });
    f.setPermission({ mode: "full-access", revision: 2 });
    await session.setWorkspaceTrust!("workspace");
    const rules = new ProjectCommandRuleStore(() => f.root);
    rules.add({ argvPrefix: ["git", "status"], anyArgs: true, cwd: "." });
    const beforeRules = rules.list(), beforeRecord = structuredClone(session.record), seen = new Set<string>();
    for (const persistence of ["session", "always", "trust", "once"] as const) {
      const abort = new AbortController(); releases.push(() => abort.abort());
      const task = session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: abort.signal }, async context => context.authorizeCommand({
        argv: ["git", "status", "space value", ""], cwd: ".", timeoutMs: 15000,
        reason: "检查项目状态", risk: "workspace_write", code: "command_ask_vcs",
      }));
      // Attach a rejection observer before a failed assertion could trigger teardown.
      void task.catch(() => undefined);
      await vi.waitFor(() => expect(session.overlay?.kind).toBe("pending-permission"));
      const overlay = session.overlay;
      if (overlay?.kind !== "pending-permission") throw new Error("Expected mandatory command overlay");
      expect(overlay).toMatchObject({ tool: "plugin_run_command", code: "plugin_command_ask", cacheable: false,
        command: '"git" "status" "space value" ""' });
      expect(overlay.projectRule).toBeUndefined(); expect(overlay.trustable).toBeUndefined();
      expect(overlay.summary).toContain("本机进程可以访问本机文件和网络");
      expect(seen.has(overlay.requestId)).toBe(false); seen.add(overlay.requestId);
      expect(await session.resolveApproval({ requestId: overlay.requestId, decision: "allow", persistence })).toMatchObject({ ok: true });
      expect(await task).toBe(true); expect(session.overlay).toBeNull();
    }
    expect(seen.size).toBe(4); expect(rules.list()).toEqual(beforeRules);
    expect(session.record).toEqual(beforeRecord); expect(session.turnInFlight).toBe(false); expect(f.resolveTurn).not.toHaveBeenCalled();
  });
  it("blocks submit, workspace switch/reset while retaining an independent idle model turn", async () => {
    const f = fixture(), session = await f.host.createSession({ backendWorkspace: f.root }), hold = deferred<void>(), entered = deferred<void>();
    releases.push(() => hold.resolve()); const before = structuredClone(session.record);
    const task = session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async context => { context.assertCurrent(); entered.resolve(); await hold.promise; return 42; });
    await entered.promise;
    expect(session.turnInFlight).toBe(false); expect(session.overlay).toBeNull();
    await expect(session.submitText("must not become a model message")).rejects.toMatchObject({ reason: "busy" });
    expect(await session.setWorkspace(f.root)).toMatchObject({ ok: false, reason: "turn_in_progress" });
    expect(await session.resetWorkspace()).toMatchObject({ ok: false, reason: "turn_in_progress" });
    expect(session.backendWorkspace).toBe(f.root); expect(session.record).toEqual(before); expect(f.resolveTurn).not.toHaveBeenCalled();
    hold.resolve(); expect(await task).toBe(42); expect(session.turnInFlight).toBe(false);
    expect(await session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async () => "next")).toBe("next");
  });
  it("uses current mode and plan lock instead of installation grants or a model turn", async () => {
    const f = fixture(), session = await f.host.createSession({ backendWorkspace: f.root }), work = vi.fn(async () => true);
    f.setPermission({ mode: "read-only", revision: 2 });
    await expect(session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, work)).rejects.toMatchObject({ reason: "read-only" });
    f.setPermission({ mode: "workspace-edit", revision: 3 });
    expect(session.updatePlan!(0, { type: "enter" }).ok).toBe(true);
    await expect(session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, work)).rejects.toMatchObject({ reason: "read-only" });
    expect(work).not.toHaveBeenCalled(); expect(f.resolveTurn).not.toHaveBeenCalled(); expect(session.turnInFlight).toBe(false);
  });
  it("invalidates an active callback when the actual permission getter changes revision", async () => {
    const f = fixture(), session = await f.host.createSession({ backendWorkspace: f.root });
    await session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async context => {
      f.setPermission({ mode: "workspace-edit", revision: 2 });
      expect(() => context.assertCurrent()).toThrow();
      await expect(context.authorizeFileChange({ path: "file.txt", diff: "-old\n+new", isNew: false })).rejects.toMatchObject({ reason: "revoked" });
    });
    expect(f.resolveTurn).not.toHaveBeenCalled(); expect(session.overlay).toBeNull();
  });
  it("releases a failed host callback without writing a conversation or starting a model", async () => {
    const f = fixture(), session = await f.host.createSession({ backendWorkspace: f.root }), before = structuredClone(session.record);
    await expect(session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async () => { throw new Error("synthetic failure"); })).rejects.toThrow("synthetic failure");
    expect(await session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async context => context.authorizeFileChange({ path: "file.txt", diff: "+new", isNew: true }))).toBe(true);
    expect(session.record).toEqual(before); expect(session.turnInFlight).toBe(false); expect(session.overlay).toBeNull(); expect(f.resolveTurn).not.toHaveBeenCalled();
  });
  it("close aborts the lease and waits for its callback to settle before teardown", async () => {
    const f = fixture(), session = await f.host.createSession({ backendWorkspace: f.root }), hold = deferred<void>(), entered = deferred<WorkspaceOperationContext>();
    releases.push(() => hold.resolve());
    const task = session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async context => { entered.resolve(context); await hold.promise; context.assertCurrent(); });
    const outcome = task.catch(error => error), context = await entered.promise;
    let closed = false; const closing = f.host.closeActiveSession().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(context.signal.aborted).toBe(true); expect(closed).toBe(false); expect(session.turnInFlight).toBe(false);
    hold.resolve(); expect(await outcome).toMatchObject({ name: "AbortError" }); await closing; expect(closed).toBe(true); expect(f.resolveTurn).not.toHaveBeenCalled();
    await expect(session.runWorkspaceOperation!({ workspaceRoot: f.root, signal: new AbortController().signal }, async () => true)).rejects.toMatchObject({ reason: "unavailable" });
  });
});
