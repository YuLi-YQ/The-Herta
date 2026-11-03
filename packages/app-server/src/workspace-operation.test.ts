import { SessionApprovalCache, type PermissionModeState, type PermissionRequest } from "@herta/core";
import type { PluginCommandPreview } from "@herta/tools";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceOperationGate, type WorkspaceOperationContext, type WorkspaceOperationRequest } from "./workspace-operation.js";
import { OverlayAskResolver } from "./overlay-ask-resolver.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(mode: PermissionModeState["mode"] = "workspace-edit") {
  const state: { closed: boolean; busy: boolean; workspaceRoot: string; permission?: PermissionModeState; planLocked: boolean } = {
    closed: false, busy: false, workspaceRoot: "C:/synthetic-workspace", permission: { mode, revision: 1 }, planLocked: false,
  };
  const ask = vi.fn(async () => "allow" as const), abort = new AbortController();
  const gate = new WorkspaceOperationGate({ state: () => state, ask });
  const request = { workspaceRoot: state.workspaceRoot, signal: abort.signal };
  return { state, ask, abort, gate, request };
}
const change = { path: "src/file.ts", diff: "--- src/file.ts\n+++ src/file.ts\n-old\n+new", isNew: false };
describe("host workspace operation lease", () => {
  it("owns one exclusive lease without claiming a model turn or invoking a model", async () => {
    const f = fixture(), held = deferred<void>(), entered = deferred<void>();
    const pending = f.gate.run(f.request, async context => { context.assertCurrent(); entered.resolve(); await held.promise; return 42; });
    await entered.promise; expect(f.gate.busy).toBe(true); expect(f.state.busy).toBe(false); expect(() => f.gate.assertIdle()).toThrow();
    await expect(f.gate.run(f.request, async () => 99)).rejects.toMatchObject({ reason: "busy" });
    held.resolve(); expect(await pending).toBe(42); expect(f.gate.busy).toBe(false); expect(() => f.gate.assertIdle()).not.toThrow();
  });
  it.each(["workspace-edit", "full-access"] as const)("uses existing %s tier for ordinary edit/create with no artificial approval card", async mode => {
    const f = fixture(mode);
    await f.gate.run(f.request, async context => {
      expect(await context.authorizeFileChange(change)).toBe(true);
      expect(await context.authorizeFileChange({ ...change, isNew: true })).toBe(true);
    });
    expect(f.ask).not.toHaveBeenCalled();
  });
  it.each([
    `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(111)}`,
    `${Array(5).fill("a".repeat(200)).join("/")}/${"b".repeat(19)}`,
  ])("accepts a syntactically relative path above 512 up to the shared 1024 limit %#", async path => {
    const f = fixture(); expect([513, 1024]).toContain(path.length);
    await f.gate.run(f.request, async context => { expect(await context.authorizeFileChange({ ...change, path })).toBe(true); });
    expect(f.ask).not.toHaveBeenCalled();
  });
  it.each(["read-only", "missing", "invalid-mode", "zero-revision", "fractional-revision", "plan"])("refuses %s before executing callback", async state => {
    const f = fixture(), work = vi.fn(async () => true);
    if (state === "read-only") f.state.permission = { mode: "read-only", revision: 1 };
    if (state === "missing") f.state.permission = undefined;
    if (state === "invalid-mode") f.state.permission = { mode: "invented", revision: 1 } as unknown as PermissionModeState;
    if (state === "zero-revision") f.state.permission = { mode: "workspace-edit", revision: 0 };
    if (state === "fractional-revision") f.state.permission = { mode: "workspace-edit", revision: 1.5 };
    if (state === "plan") f.state.planLocked = true;
    await expect(f.gate.run(f.request, work)).rejects.toMatchObject({ reason: "read-only" });
    expect(work).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled(); expect(f.gate.busy).toBe(false);
  });
  it.each(["closed", "busy", "wrong-root"])("refuses unavailable owner state %s", async kind => {
    const f = fixture(), work = vi.fn(async () => true);
    if (kind === "closed") f.state.closed = true;
    if (kind === "busy") f.state.busy = true;
    if (kind === "wrong-root") f.request.workspaceRoot = "C:/other";
    await expect(f.gate.run(f.request, work)).rejects.toMatchObject({ reason: "unavailable" }); expect(work).not.toHaveBeenCalled();
  });
  it.each(["root", "revision", "mode", "permission-missing", "plan", "owner-busy", "owner-closed"])("rejects late authorization after %s changes", async kind => {
    const f = fixture();
    await f.gate.run(f.request, async context => {
      if (kind === "root") f.state.workspaceRoot = "C:/other";
      if (kind === "revision") f.state.permission = { mode: "workspace-edit", revision: 2 };
      if (kind === "mode") f.state.permission = { mode: "full-access", revision: 1 };
      if (kind === "permission-missing") f.state.permission = undefined;
      if (kind === "plan") f.state.planLocked = true;
      if (kind === "owner-busy") f.state.busy = true;
      if (kind === "owner-closed") f.state.closed = true;
      expect(() => context.assertCurrent()).toThrow(); await expect(context.authorizeFileChange(change)).rejects.toBeDefined();
    });
    expect(f.ask).not.toHaveBeenCalled(); expect(f.gate.busy).toBe(false);
  });
  it("captures permission primitives even if a host getter reuses a mutable object", async () => {
    const f = fixture();
    await f.gate.run(f.request, async context => {
      (f.state.permission as { revision: number }).revision = 2;
      expect(() => context.assertCurrent()).toThrow(); await expect(context.authorizeFileChange(change)).rejects.toBeDefined();
    });
  });
  it("rejects a signal aborted before entry without acquiring a lease", async () => {
    const f = fixture(), work = vi.fn(async () => true); f.abort.abort();
    await expect(f.gate.run(f.request, work)).rejects.toMatchObject({ name: "AbortError" }); expect(work).not.toHaveBeenCalled(); expect(f.gate.busy).toBe(false);
  });
  it("propagates abort, refuses late work, and releases only after callback settles", async () => {
    const f = fixture(), held = deferred<void>(), entered = deferred<WorkspaceOperationContext>();
    const pending = f.gate.run(f.request, async context => { entered.resolve(context); await held.promise; await context.authorizeFileChange(change); });
    const outcome = pending.catch(error => error), context = await entered.promise;
    f.abort.abort(); expect(context.signal.aborted).toBe(true); expect(f.gate.busy).toBe(true); held.resolve();
    expect(await outcome).toMatchObject({ name: "AbortError" }); expect(f.gate.busy).toBe(false); expect(f.ask).not.toHaveBeenCalled();
  });
  it("close aborts the owner and waits for real callback settlement", async () => {
    const f = fixture(), held = deferred<void>(), entered = deferred<WorkspaceOperationContext>();
    const pending = f.gate.run(f.request, async context => { entered.resolve(context); await held.promise; context.assertCurrent(); });
    const outcome = pending.catch(error => error), context = await entered.promise;
    let closed = false; const closing = f.gate.close()!.then(() => { closed = true; });
    expect(context.signal.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false); expect(f.gate.busy).toBe(true);
    held.resolve(); expect(await outcome).toMatchObject({ name: "AbortError" }); await closing; expect(closed).toBe(true); expect(f.gate.busy).toBe(false);
    await expect(f.gate.run(f.request, async () => true)).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("releases a callback failure and does not poison the next lease", async () => {
    const f = fixture(), failure = new Error("synthetic callback failed");
    await expect(f.gate.run(f.request, async () => { throw failure; })).rejects.toBe(failure);
    expect(f.gate.busy).toBe(false); expect(await f.gate.run(f.request, async () => 7)).toBe(7);
  });
  it("expires retained context at settlement so it cannot operate outside its lease", async () => {
    const f = fixture(); let old!: WorkspaceOperationContext;
    await f.gate.run(f.request, async context => { old = context; });
    expect(() => old.assertCurrent()).toThrow(); await expect(old.authorizeFileChange(change)).rejects.toBeDefined();
  });
  it.each([null, {}, { ...change, path: "" }, { ...change, path: " " }, { ...change, path: "../outside" },
    { ...change, path: "/outside" }, { ...change, path: "C:/outside" }, { ...change, path: "file\0.txt" },
    { ...change, path: "x".repeat(1025) }, { ...change, diff: 1 }, { ...change, diff: "x".repeat(512001) },
    { ...change, isNew: "yes" }, { ...change, approved: true }])("rejects unknown or malformed file preview %#", async bad => {
    const f = fixture();
    await f.gate.run(f.request, async context => { await expect(context.authorizeFileChange(bad as never)).rejects.toMatchObject({ reason: "unavailable" }); });
    expect(f.ask).not.toHaveBeenCalled();
  });
  it.each([null, {}, { workspaceRoot: "C:/synthetic-workspace" }, { workspaceRoot: "C:/synthetic-workspace", signal: {} },
    { workspaceRoot: "C:/synthetic-workspace", signal: new AbortController().signal, grant: true }])("rejects unknown or malformed lease request %#", async bad => {
    const f = fixture(), work = vi.fn(async () => true);
    await expect(f.gate.run(bad as WorkspaceOperationRequest, work)).rejects.toBeDefined(); expect(work).not.toHaveBeenCalled(); expect(f.gate.busy).toBe(false);
  });
});

describe("plugin network permission", () => {
  function networkFixture(mode: PermissionModeState["mode"] = "workspace-edit") {
    const f = fixture(mode);
    const ask = vi.fn<(request: PermissionRequest, signal: AbortSignal) => Promise<"allow" | "deny">>(async () => "allow");
    return { ...f, ask, gate: new WorkspaceOperationGate({ state: () => f.state, ask }) };
  }
  const request = { url: "https://example.com/review?item=alpha&view=full", method: "POST" as const, bodyBytes: 42 };

  it("waits within the broker budget and approves an immutable full destination summary", async () => {
    vi.useFakeTimers();
    try {
      const f = networkFixture(), answer = deferred<"allow" | "deny">(), mutable = { ...request };
      f.ask.mockReturnValue(answer.promise);
      let settled = false;
      const pending = f.gate.run(f.request, async context => context.authorizeNetworkRequest(mutable)).then(value => { settled = true; return value; });
      expect(f.ask).toHaveBeenCalledTimes(1);
      const [prompt, signal] = f.ask.mock.calls[0]!;
      expect(prompt).toMatchObject({ risk: "network", code: "plugin_network_request_ask", call: { tool: "plugin_network_request", input: request } });
      expect(Object.keys(prompt.call.input!)).toEqual(["method", "url", "bodyBytes"]);
      expect(prompt.reason).toContain(request.url);
      expect(Object.isFrozen(prompt)).toBe(true); expect(Object.isFrozen(prompt.call.input)).toBe(true);
      mutable.url = "https://other.example/changed"; mutable.bodyBytes = 65536;
      await vi.advanceTimersByTimeAsync(59999);
      expect(settled).toBe(false); expect(signal.aborted).toBe(false);
      expect(prompt.call.input).toEqual(request);
      answer.resolve("allow"); expect(await pending).toBe(true); expect(f.gate.busy).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("returns a denied workspace-edit approval without silently widening permissions", async () => {
    const f = networkFixture(); f.ask.mockResolvedValue("deny");
    expect(await f.gate.run(f.request, async context => context.authorizeNetworkRequest(request))).toBe(false);
    expect(f.ask).toHaveBeenCalledTimes(1); expect(f.gate.busy).toBe(false);
  });

  it("uses existing full-access coverage for all seven methods and bounded byte summaries", async () => {
    const f = networkFixture("full-access");
    await f.gate.run(f.request, async context => {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        expect(await context.authorizeNetworkRequest({ ...request, method, bodyBytes: method === "GET" || method === "HEAD" ? 0 : 65536 })).toBe(true);
      }
    });
    expect(f.ask).not.toHaveBeenCalled();
  });

  it("rejects read-only and plan-locked work before the network callback can ask", async () => {
    for (const plan of [false, true]) {
      const f = networkFixture(plan ? "workspace-edit" : "read-only"); f.state.planLocked = plan;
      const work = vi.fn(async (context: WorkspaceOperationContext) => context.authorizeNetworkRequest(request));
      await expect(f.gate.run(f.request, work)).rejects.toMatchObject({ reason: "read-only" });
      expect(work).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
    }
  });

  it("propagates broker cancellation during approval and rejects a late allow", async () => {
    const f = networkFixture(), answer = deferred<"allow" | "deny">(); f.ask.mockReturnValue(answer.promise);
    const pending = f.gate.run(f.request, async context => context.authorizeNetworkRequest(request));
    const outcome = pending.catch(error => error);
    f.abort.abort(); expect(f.ask.mock.calls[0]![1].aborted).toBe(true);
    answer.resolve("allow"); expect(await outcome).toMatchObject({ name: "AbortError" }); expect(f.gate.busy).toBe(false);
  });

  it("rechecks the captured owner permission revision after approval", async () => {
    const f = networkFixture(), answer = deferred<"allow" | "deny">(); f.ask.mockReturnValue(answer.promise);
    const pending = f.gate.run(f.request, async context => context.authorizeNetworkRequest(request));
    const outcome = pending.catch(error => error);
    f.state.permission = { mode: "workspace-edit", revision: 2 }; answer.resolve("allow");
    expect(await outcome).toMatchObject({ reason: "revoked" }); expect(f.gate.busy).toBe(false);
  });

  it("rejects malformed destinations, unknown fields, accessors, and invalid byte summaries before asking", async () => {
    const f = networkFixture(), getter = vi.fn(() => request.url);
    const invalid = [null, [], {}, { ...request, body: "must never enter approval" }, { ...request, headers: {} },
      { ...request, url: "http://example.com/" }, { ...request, url: "https://user:secret@example.com/" },
      { ...request, url: "https://example.com/#fragment" }, { ...request, url: "https://example.com/#" },
      { ...request, url: "https://example.com/a\nb" }, { ...request, url: "https://example.com/\\path" },
      { ...request, url: `https://example.com/${"a".repeat(2048)}` }, { ...request, url: "https://example.com/\ud800" },
      { ...request, method: "post" }, { ...request, method: "CONNECT" }, { ...request, bodyBytes: -1 },
      { ...request, bodyBytes: 65537 }, { ...request, bodyBytes: 0.5 }, { ...request, bodyBytes: NaN },
      { ...request, bodyBytes: "42" }, Object.create(request),
      Object.defineProperty({ method: request.method, bodyBytes: request.bodyBytes }, "url", { get: getter, enumerable: true }),
      { ...request, [Symbol("extra")]: true }];
    await f.gate.run(f.request, async context => {
      for (const bad of invalid) await expect(context.authorizeNetworkRequest(bad as never)).rejects.toMatchObject({ reason: "unavailable" });
    });
    expect(getter).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
  });

  it("releases an approval failure and invalidates the retained network context", async () => {
    const f = networkFixture(), failure = new Error("synthetic approval failure"); let retained!: WorkspaceOperationContext;
    f.ask.mockRejectedValueOnce(failure);
    await expect(f.gate.run(f.request, async context => { retained = context; return context.authorizeNetworkRequest(request); })).rejects.toBe(failure);
    expect(f.gate.busy).toBe(false);
    await expect(retained.authorizeNetworkRequest(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(await f.gate.run(f.request, async context => context.authorizeNetworkRequest(request))).toBe(true);
    expect(f.ask).toHaveBeenCalledTimes(2);
  });
});

describe("plugin command permission", () => {
  const preview: PluginCommandPreview = { argv: ["git", "status"], cwd: ".", timeoutMs: 15000,
    reason: "检查项目状态", risk: "workspace_read", code: "command_ask_unknown" };
  function commandFixture(mode: PermissionModeState["mode"] = "workspace-edit") {
    const f = fixture(mode);
    const ask = vi.fn<(request: PermissionRequest, signal: AbortSignal) => Promise<"allow" | "deny">>(async () => "allow");
    return { ...f, ask, gate: new WorkspaceOperationGate({ state: () => f.state, ask }) };
  }

  it("lease watch aborts an idle approval after permission changes without status polling", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture("full-access"), shown = vi.fn(), cleared = vi.fn();
      const resolver = new OverlayAskResolver({ cache: new SessionApprovalCache(), setPendingOverlay: shown, clearOverlay: cleared });
      const gate = new WorkspaceOperationGate({ state: () => f.state, ask: (request, signal) => resolver.present(request, signal) });
      let ownedSignal!: AbortSignal;
      const task = gate.run(f.request, context => { ownedSignal = context.signal; return context.authorizeCommand(preview); });
      const outcome = task.catch(error => error);
      expect(shown).toHaveBeenCalledTimes(1); expect(ownedSignal.aborted).toBe(false);
      const requestId = shown.mock.calls[0]![0].requestId as string;
      f.state.permission = { mode: "full-access", revision: 2 };
      // No retained context assertion, status request, or renderer work follows.
      await vi.advanceTimersByTimeAsync(100);
      expect(ownedSignal.aborted).toBe(true); expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(cleared).toHaveBeenCalledExactlyOnceWith(requestId); expect(gate.busy).toBe(false);
      expect(resolver.resolveExternal({ requestId, decision: "allow" })).toMatchObject({ ok: false, reason: "no_pending_overlay" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("always asks in full-access and freezes the complete command before approval", async () => {
    const f = commandFixture("full-access"), answer = deferred<"allow" | "deny">();
    const mutable = { ...preview, argv: ["git", "status", "space value", ""], cwd: "src", timeoutMs: 60000 };
    f.ask.mockReturnValue(answer.promise);
    const task = f.gate.run(f.request, context => context.authorizeCommand(mutable));
    expect(f.ask).toHaveBeenCalledTimes(1);
    const prompt = f.ask.mock.calls[0]![0];
    expect(prompt).toMatchObject({ code: "plugin_command_ask", risk: "workspace_read",
      call: { tool: "plugin_run_command", input: { argv: ["git", "status", "space value", ""], cwd: "src", timeoutMs: 60000 } } });
    expect(prompt.reason).toContain("本机进程可以访问本机文件和网络"); expect(prompt.reason).toContain("src");
    expect(Object.isFrozen(prompt.argv)).toBe(true); expect(Object.isFrozen(prompt.call.input)).toBe(true);
    mutable.argv[0] = "other"; mutable.cwd = "changed"; mutable.reason = "changed"; mutable.timeoutMs = 1;
    expect(prompt.argv?.[0]).toBe("git"); expect(prompt.reason).toContain("检查项目状态");
    answer.resolve("allow"); expect(await task).toBe(true); expect(f.gate.busy).toBe(false);
  });

  it("never reaches execution after denial, cancellation, or a permission revision change", async () => {
    for (const scenario of ["deny", "abort", "revoked"] as const) {
      const f = commandFixture(), answer = deferred<"allow" | "deny">(), execute = vi.fn();
      f.ask.mockReturnValue(answer.promise);
      const task = f.gate.run(f.request, async context => { if (await context.authorizeCommand(preview)) execute(); });
      const outcome = task.catch(error => error);
      if (scenario === "abort") { f.abort.abort(); expect(f.ask.mock.calls[0]![1].aborted).toBe(true); }
      if (scenario === "revoked") f.state.permission = { mode: "workspace-edit", revision: 2 };
      answer.resolve(scenario === "deny" ? "deny" : "allow");
      const result = await outcome;
      if (scenario === "deny") expect(result).toBeUndefined();
      else expect(result).toMatchObject(scenario === "abort" ? { name: "AbortError" } : { reason: "revoked" });
      expect(execute).not.toHaveBeenCalled(); expect(f.gate.busy).toBe(false);
    }
  });

  it("rejects unknown fields, invalid previews and accessors without calling them or asking", async () => {
    const f = commandFixture(), getter = vi.fn(() => "git");
    const getterArgv = Object.defineProperty(["git"], "0", { get: getter });
    const invalid = [null, {}, { ...preview, env: {} }, { ...preview, argv: [] }, { ...preview, argv: ["git", , "status"] },
      { ...preview, argv: getterArgv }, { ...preview, argv: ["git", "x\n"] }, { ...preview, argv: Array(64).fill("中".repeat(2048)) },
      { ...preview, cwd: "../outside" }, { ...preview, cwd: "/root" }, { ...preview, cwd: "C:\\root" }, { ...preview, cwd: "a/./b" },
      { ...preview, cwd: "a:" }, { ...preview, cwd: "a/ " }, { ...preview, timeoutMs: 0 }, { ...preview, timeoutMs: 60001 },
      { ...preview, risk: "safe" }, { ...preview, code: "x\n" }, { ...preview, consequence: "invented" },
      { ...preview, reason: "x".repeat(4001) }, { ...preview, argv: ["\ud800"] }, Object.create(preview),
      Object.defineProperty({ ...preview }, "reason", { get: getter }), { ...preview, [Symbol("extra")]: true }];
    await f.gate.run(f.request, async context => {
      for (const value of invalid) await expect(context.authorizeCommand(value as never)).rejects.toMatchObject({ reason: "unavailable" });
    });
    expect(getter).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
  });

  it("retains read-only and plan denial before any command approval", async () => {
    for (const plan of [false, true]) {
      const f = commandFixture(plan ? "full-access" : "read-only"); f.state.planLocked = plan;
      const work = vi.fn(async (context: WorkspaceOperationContext) => context.authorizeCommand(preview));
      await expect(f.gate.run(f.request, work)).rejects.toMatchObject({ reason: "read-only" });
      expect(work).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
    }
  });
});
