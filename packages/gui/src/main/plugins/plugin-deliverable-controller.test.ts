import { createHash } from "node:crypto";
import nodefs, { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginOutputOwner, PluginOutputProducer, PluginOutputReply, PluginPatchContent } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault, type PluginCapabilityContext } from "./capability-broker.js";
import type { ExecutablePluginOwner } from "./executable-plugin-controller.js";
import { ExecutablePluginStore } from "./executable-plugin-store.js";
import { PluginPatchService } from "./plugin-patch-service.js";
import { createPluginDeliverableController, type PluginDeliverableControllerOptions } from "./plugin-deliverable-controller.js";

const roots: string[] = [], controllers: ReturnType<typeof createPluginDeliverableController>[] = [];
const owner: PluginOutputOwner = { scope: "workbench", target: "fixture-workbench" };
const chat: PluginOutputOwner = { scope: "chat", target: "fixture-chat" };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function good(reply: PluginOutputReply): Extract<PluginOutputReply, { ok: true }> { if (!reply.ok) throw Error(reply.message); return reply; }
async function until<T>(read: () => Promise<T>, pass: (result: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) { const result = await read(); if (pass(result)) return result; if (Date.now() > deadline) throw Error("Fixture timeout: " + JSON.stringify(result).slice(0, 800)); await pause(5); }
}
const detached = { signal: new AbortController().signal, assertCurrent() {} };
async function fixture(noLease = false) {
  const root = await fs.mkdtemp(join(tmpdir(), "herta-deliverable-controller-")); roots.push(root);
  const profile = join(root, "profile"), workspace = join(root, "workspace"), destination = join(root, "saved.md"); await fs.mkdir(profile); await fs.mkdir(workspace);
  const source = join(root, "fixture.json");
  await fs.writeFile(source, JSON.stringify({ manifest: { schemaVersion: 2, apiVersion: 1, id: "example.output", name: "合成插件", version: "1.0.0", description: "Synthetic only", entry: "main.js",
    capabilities: [{ name: "artifacts.create" }, { name: "workspace.proposePatch" }], actions: [
      { id: "run", title: "生成", export: "run", scope: "workbench", inputs: [], capabilities: ["artifacts.create", "workspace.proposePatch"] },
      { id: "artifact", title: "生成文件", export: "run", scope: "both", inputs: [], capabilities: ["artifacts.create"] },
    ] }, files: [{ path: "main.js", source: "export function run(){return null}" }] }));
  const store = new ExecutablePluginStore({ profileDir: profile, chooseFile: async () => source });
  const preview = await store.request({ kind: "preview" }); if (!preview.ok || !preview.preview) throw Error(preview.ok ? "Fixture preview absent" : preview.message);
  const installed = await store.request({ kind: "confirm", previewId: preview.preview.id, revision: preview.snapshot.revision, grants: ["artifacts.create", "workspace.proposePatch"] });
  if (!installed.ok) throw Error(installed.message); const item = installed.snapshot.items[0]!;
  const producer: PluginOutputProducer = { id: item.manifest.id, name: item.manifest.name, version: item.manifest.version, contentHash: item.contentHash, grantRevision: item.grantRevision };
  let workOwner: ExecutablePluginOwner = { id: owner.target, revision: 1, busy: false, permissionMode: "workspace-edit", permissionRevision: 1, planActive: false, workspaceRoot: workspace };
  let chatOwner: ExecutablePluginOwner = { id: chat.target, revision: 1, busy: false, permissionMode: "read-only", permissionRevision: 0, planActive: false };
  const chooser = vi.fn(async (_name: string) => ({ canceled: false, filePath: destination }));
  const approvals: { path: string; diff: string; isNew: boolean }[] = [], leases: AbortSignal[] = [];
  let approval: (signal: AbortSignal) => Promise<boolean> = async () => true, failBefore = false, failAfter = false, leaseBusy = false, completedLeases = 0;
  const lease: NonNullable<PluginDeliverableControllerOptions["withWorkspaceOperation"]> = async <T>(_owner: PluginOutputOwner, _root: string, signal: AbortSignal, work: Parameters<NonNullable<PluginDeliverableControllerOptions["withWorkspaceOperation"]>>[3]) => {
    leases.push(signal); if (failBefore) throw Error("synthetic lease unavailable");
    if (leaseBusy) workOwner = { ...workOwner, busy: true };
    try {
      const result = await work({ signal, assertCurrent() { if (signal.aborted) throw new PluginBrokerFault("cancelled"); },
        authorizeCommand: async () => false, authorizeNetworkRequest: async () => false, authorizeFileChange: async change => { approvals.push(change); return approval(signal); } });
      if (failAfter) throw Error("synthetic wrapper failed after work"); return result as T;
    } finally { completedLeases++; if (leaseBusy) workOwner = { ...workOwner, busy: false }; }
  };
  const options: PluginDeliverableControllerOptions = { profile, protectedPaths: [profile], store, owner: scope => scope === "chat" ? chatOwner : workOwner,
    chooseArtifactPath: chooser, ...(noLease ? {} : { withWorkspaceOperation: lease }) };
  const controller = createPluginDeliverableController(options); controllers.push(controller);
  const context = (selected = owner): PluginCapabilityContext => {
    const current = selected.scope === "chat" ? chatOwner : workOwner, abort = new AbortController();
    return { signal: abort.signal, binding: { pluginId: producer.id, contentHash: producer.contentHash, grantRevision: producer.grantRevision, scope: selected.scope,
      sessionId: selected.target, sessionRevision: current.revision, permissionRevision: current.permissionRevision, actionId: selected.scope === "chat" ? "artifact" : "run" },
      assertCurrent() { const now = selected.scope === "chat" ? chatOwner : workOwner;
        if (now.id !== current.id || now.revision !== current.revision || now.permissionRevision !== current.permissionRevision || now.workspaceRoot !== current.workspaceRoot) throw new PluginBrokerFault("revoked"); } };
  };
  const readPatch = async (id: string) => good(await controller.request({ kind: "patch-read", ...owner, id })).patch!;
  return { root, profile, workspace, destination, store, producer, controller, options, chooser, approvals, leases, context, readPatch, completedLeases: () => completedLeases,
    change: (change: Partial<ExecutablePluginOwner>) => { workOwner = { ...workOwner, ...change }; },
    changeChat: (change: Partial<ExecutablePluginOwner>) => { chatOwner = { ...chatOwner, ...change }; },
    behavior: (value: { failBefore?: boolean; failAfter?: boolean; busy?: boolean }) => { failBefore = !!value.failBefore; failAfter = !!value.failAfter; leaseBusy = !!value.busy; },
    hold() { const done = deferred<boolean>(); approval = signal => new Promise<boolean>((resolve, reject) => {
      const abort = () => reject(new PluginBrokerFault("cancelled")); if (signal.aborted) return abort(); signal.addEventListener("abort", abort, { once: true });
      done.promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, reject);
    }); return done; },
    artifact: (selected = owner) => controller.createArtifact(selected, producer, "fixture-run", { name: "report.md", mime: "text/markdown", text: "精确产物\r\n" }, context(selected)),
    proposal: async (path = "file.txt") => { await fs.writeFile(join(workspace, path), "old\n"); return controller.createProposal(owner, producer, "fixture-run", { path, baseHash: sha("old\n"), content: "new\n" }, workspace, context()); },
    terminal: (id: string) => until(() => readPatch(id), content => !["pending", "applying"].includes(content.proposal.status)),
    disable: async () => { const listing = await store.request({ kind: "list" }); if (!listing.ok) throw Error(listing.message); return store.request({ kind: "enable", id: producer.id, enabled: false, revision: listing.snapshot.revision }); },
  };
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  // Every held fixture authorization listens to abort, so owned jobs settle promptly.
  await pause(30); vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const absolute = resolve(root); if (!isPathInside(resolve(tmpdir()), absolute, { strict: true }) || !basename(absolute).startsWith("herta-deliverable-controller-") || (await fs.lstat(absolute)).isSymbolicLink()) throw Error("Unsafe fixture cleanup");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe("host deliverable controller with real stores and synthetic workspace lease", () => {
  it("R144 reports pending save dialogs and background approvals as busy until their real completion", async () => {
    const f=await fixture(),artifact=await f.artifact(),choose=deferred<{canceled:boolean;filePath:string}>();
    f.chooser.mockImplementationOnce(async()=>choose.promise);
    const saving=f.controller.request({kind:"artifact-save",...owner,id:artifact.id});
    await until(async()=>f.chooser.mock.calls.length,count=>count===1);expect(f.controller.isBusy()).toBe(true);
    choose.resolve({canceled:true,filePath:f.destination});await saving;expect(f.controller.isBusy()).toBe(false);
    const proposal=await f.proposal(),approval=f.hold();
    expect(good(await f.controller.request({kind:"patch-apply",...owner,id:proposal.id})).applying).toBe(true);
    await until(async()=>f.approvals.length,count=>count===1);expect(f.controller.isBusy()).toBe(true);
    approval.resolve(true);await f.terminal(proposal.id);
    await until(async()=>f.controller.isBusy(),busy=>!busy);
  });
  it("keeps both scopes' artifacts separate, readable while busy, and persistent after restart/disable", async () => {
    const f = await fixture(), a = await f.artifact(), b = await f.artifact(chat); await f.disable();
    f.change({ busy: true }); f.changeChat({ busy: true });
    expect(good(await f.controller.request({ kind: "outputs-list", ...owner })).outputs?.artifacts.map(item => item.id)).toEqual([a.id]);
    expect(good(await f.controller.request({ kind: "outputs-list", ...chat })).outputs?.artifacts.map(item => item.id)).toEqual([b.id]);
    f.controller.dispose(); const reopened = createPluginDeliverableController(f.options); controllers.push(reopened);
    expect(good(await reopened.request({ kind: "artifact-read", ...chat, id: b.id })).content).toBe("精确产物\r\n");
    expect(await reopened.request({ kind: "artifact-save", ...owner, id: a.id })).toEqual({ ok: true, saved: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe("精确产物\r\n");
  });
  it("refuses unknown/old targets, extra content/path fields and cross-scope ids without disclosure", async () => {
    const f = await fixture(), a = await f.artifact();
    for (const input of [
      { kind: "artifact-read", ...owner, target: "old", id: a.id }, { kind: "artifact-read", ...chat, id: a.id },
      { kind: "artifact-save", ...owner, id: a.id, filePath: f.destination }, { kind: "outputs-list", ...owner, content: "injected" },
      { kind: "unknown", ...owner }, { kind: "artifact-read", ...owner, id: "../private" },
    ]) expect(await f.controller.request(input)).toMatchObject({ ok: false });
    expect(f.chooser).not.toHaveBeenCalled();
  });
  it("rejects forged producer/binding and another root for creation", async () => {
    const f = await fixture();
    await expect(f.controller.createArtifact(owner, { ...f.producer, contentHash: "b".repeat(64) }, "run", { name: "x", mime: "text/plain", text: "x" }, f.context())).rejects.toMatchObject({ code: "revoked" });
    await expect(f.controller.createProposal(owner, f.producer, "run", { path: "x", baseHash: null, content: "x" }, f.root, f.context())).rejects.toMatchObject({ code: "capability-denied" });
    expect(good(await f.controller.request({ kind: "outputs-list", ...owner })).outputs?.artifacts).toHaveLength(0);
  });
  it("accepts a selected junction only when it matches the host's captured physical root", async () => {
    const f = await fixture(), alias = join(f.root, "project-alias"); await fs.symlink(f.workspace, alias, "junction"); f.change({ workspaceRoot: alias });
    const p = await f.controller.createProposal(owner, f.producer, "run", { path: "new.txt", baseHash: null, content: "proposed" }, alias, f.context(), f.workspace);
    expect((await f.readPatch(p.id)).after).toBe("proposed"); await expect(fs.stat(join(f.workspace, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("continues against the fixed root if a real junction changes after the validation read", async () => {
    const f = await fixture(), alias = join(f.root, "project-alias"), elsewhere = join(f.root, "other-project");
    await fs.mkdir(elsewhere); await fs.writeFile(join(f.workspace, "file.txt"), "original project"); await fs.writeFile(join(elsewhere, "file.txt"), "other project");
    await fs.symlink(f.workspace, alias, "junction"); f.change({ workspaceRoot: alias });
    const original = fs.realpath.bind(fs); let redirected = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (path, options) => {
      const result = await original(path, options);
      if (String(path) === alias && !redirected) { redirected = true; await fs.unlink(alias); await fs.symlink(elsewhere, alias, "junction"); }
      return result;
    });
    const p = await f.controller.createProposal(owner, f.producer, "run", { path: "file.txt", baseHash: sha("original project"), content: "proposed" }, alias, f.context(), f.workspace);
    expect(redirected).toBe(true); expect((await f.readPatch(p.id)).before).toBe("original project");
    expect(await fs.readFile(join(elsewhere, "file.txt"), "utf8")).toBe("other project");
  });
  it("refuses an alias that was already redirected before physical-root validation", async () => {
    const f = await fixture(), alias = join(f.root, "project-alias"), elsewhere = join(f.root, "other-project"); await fs.mkdir(elsewhere); await fs.symlink(elsewhere, alias, "junction");
    f.change({ workspaceRoot: alias }); const staging = vi.spyOn(PluginPatchService.prototype, "create");
    await expect(f.controller.createProposal(owner, f.producer, "run", { path: "x", baseHash: null, content: "x" }, alias, f.context(), f.workspace)).rejects.toMatchObject({ code: "revoked" });
    expect(staging).not.toHaveBeenCalled(); expect(await fs.readdir(elsewhere)).toEqual([]);
  });
  it("rechecks owner after awaiting realpath and keeps the service untouched on owner changes", async () => {
    const f = await fixture(), original = fs.realpath.bind(fs), staging = vi.spyOn(PluginPatchService.prototype, "create");
    vi.spyOn(fs, "realpath").mockImplementation(async (path, options) => { const result = await original(path, options); if (String(path) === f.workspace) f.change({ revision: 2 }); return result; });
    await expect(f.controller.createProposal(owner, f.producer, "run", { path: "x", baseHash: null, content: "x" }, f.workspace, f.context(), f.workspace)).rejects.toMatchObject({ code: "revoked" });
    expect(staging).not.toHaveBeenCalled();
  });
  it("refuses a save whose owner changed while the native chooser was pending", async () => {
    const f = await fixture(), a = await f.artifact(), choice = deferred<{ canceled: boolean; filePath: string }>();
    f.chooser.mockReturnValueOnce(choice.promise); const saving = f.controller.request({ kind: "artifact-save", ...owner, id: a.id });
    await until(async () => f.chooser.mock.calls.length, count => count === 1); f.change({ revision: 2 }); choice.resolve({ canceled: false, filePath: f.destination });
    expect(await saving).toMatchObject({ ok: false }); await expect(fs.stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("aborts pending save guards on disposal", async () => {
    const f = await fixture(), a = await f.artifact(), choice = deferred<{ canceled: boolean; filePath: string }>();
    f.chooser.mockReturnValueOnce(choice.promise); const saving = f.controller.request({ kind: "artifact-save", ...owner, id: a.id });
    await until(async () => f.chooser.mock.calls.length, count => count === 1); f.controller.dispose(); choice.resolve({ canceled: false, filePath: f.destination });
    expect(await saving).toMatchObject({ ok: false }); await expect(fs.stat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([{ busy: true }, { permissionMode: "read-only" as const }, { planActive: true }])("refuses an ineligible workspace before acquiring a lease (%#)", async change => {
    const f = await fixture(), p = await f.proposal(); f.change(change);
    expect(await f.controller.request({ kind: "patch-apply", ...owner, id: p.id })).toMatchObject({ ok: false }); expect(f.leases).toHaveLength(0);
    expect(await fs.readFile(join(f.workspace, p.path), "utf8")).toBe("old\n");
  });
  it("does not apply without the actual workspace lease hook", async () => {
    const f = await fixture(true), p = await f.proposal(); expect(await f.controller.request({ kind: "patch-apply", ...owner, id: p.id })).toMatchObject({ ok: false });
  });
  it("keeps a waiting approval visibly applying, rejects duplicate jobs and applies only after authorization", async () => {
    const f = await fixture(), p = await f.proposal(), held = f.hold();
    expect(await f.controller.request({ kind: "patch-apply", ...owner, id: p.id })).toEqual({ ok: true, applying: true });
    await until(async () => f.approvals.length, count => count === 1);
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, detached)).proposal.status).toBe("pending");
    expect((await f.readPatch(p.id)).proposal).toMatchObject({ status: "applying", message: expect.stringContaining("检查") });
    expect(good(await f.controller.request({ kind: "outputs-list", ...owner })).outputs?.proposals[0]?.status).toBe("applying");
    await f.controller.request({ kind: "patch-apply", ...owner, id: p.id }); expect(f.leases).toHaveLength(1);
    expect(await fs.readFile(join(f.workspace, p.path), "utf8")).toBe("old\n");
    held.resolve(true); expect((await f.terminal(p.id)).proposal.status).toBe("applied");
    expect(f.approvals[0]).toMatchObject({ path: p.path, isNew: false, diff: expect.stringContaining("-old") });
    expect(await fs.readFile(join(f.workspace, p.path), "utf8")).toBe("new\n");
    await until(() => f.controller.request({ kind: "patch-apply", ...owner, id: p.id }), reply => !reply.ok);
    expect(f.leases).toHaveLength(1);
  });
  it("does not revoke its own lease merely because the host reports the operation as busy", async () => {
    const f = await fixture(), p = await f.proposal(); f.behavior({ busy: true });
    expect(await f.controller.request({ kind: "patch-apply", ...owner, id: p.id })).toMatchObject({ ok: true });
    expect((await f.terminal(p.id)).proposal.status).toBe("applied");
  });
  it("archives denial and user cancellation without writing project bytes", async () => {
    const f = await fixture(), denied = await f.proposal(), held = f.hold();
    await f.controller.request({ kind: "patch-apply", ...owner, id: denied.id }); await until(async () => f.approvals.length, count => count === 1);
    held.resolve(false); expect((await f.terminal(denied.id)).proposal.status).toBe("denied");
    const waiting = await f.proposal("second.txt"); f.hold(); await f.controller.request({ kind: "patch-apply", ...owner, id: waiting.id });
    await until(async () => f.approvals.length, count => count === 2);
    expect(await f.controller.request({ kind: "patch-cancel", ...owner, id: waiting.id })).toEqual({ ok: true, applying: true });
    expect((await f.terminal(waiting.id)).proposal.status).toBe("cancelled");
    expect(await fs.readFile(join(f.workspace, "second.txt"), "utf8")).toBe("old\n");
  });
  it("cancels an unstarted proposal persistently", async () => {
    const f = await fixture(), p = await f.proposal();
    expect(good(await f.controller.request({ kind: "patch-cancel", ...owner, id: p.id })).patch?.proposal.status).toBe("cancelled");
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, detached)).proposal.status).toBe("cancelled");
  });
  it("immediately revokes a pending approval when the source plugin is disabled", async () => {
    const f = await fixture(), p = await f.proposal(); f.hold(); await f.controller.request({ kind: "patch-apply", ...owner, id: p.id });
    await until(async () => f.approvals.length, count => count === 1); await f.disable();
    expect(f.leases[0]?.aborted).toBe(true); expect((await f.terminal(p.id)).proposal.status).toBe("cancelled");
    expect(await f.controller.request({ kind: "patch-apply", ...owner, id: p.id })).toMatchObject({ ok: false });
    expect(await fs.readFile(join(f.workspace, p.path), "utf8")).toBe("old\n");
  });
  it.each(["permission", "plan", "root", "owner"])("revokes pending approval on %s changes", async change => {
    const f = await fixture(), p = await f.proposal(); f.hold(); await f.controller.request({ kind: "patch-apply", ...owner, id: p.id });
    await until(async () => f.approvals.length, count => count === 1);
    if (change === "permission") f.change({ permissionRevision: 2 });
    else if (change === "plan") f.change({ planActive: true });
    else if (change === "root") f.change({ workspaceRoot: f.root });
    else f.change({ id: "another", revision: 2 });
    await until(async () => f.leases[0]?.aborted, value => value === true);
    if (change === "owner") expect(await f.controller.request({ kind: "patch-read", ...owner, id: p.id })).toMatchObject({ ok: false });
    f.change({ id: owner.target, revision: 3, workspaceRoot: f.workspace });
    expect((await f.terminal(p.id)).proposal.status).toBe("cancelled"); expect(await fs.readFile(join(f.workspace, p.path), "utf8")).toBe("old\n");
  });
  it("shows a lease failure as terminal and archives it instead of returning to pending", async () => {
    const f = await fixture(), p = await f.proposal(); f.behavior({ failBefore: true });
    await f.controller.request({ kind: "patch-apply", ...owner, id: p.id }); expect((await f.terminal(p.id)).proposal.status).toBe("failed");
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, detached)).proposal.status).not.toBe("pending");
  });
  it("marks an unconfirmed post-job read as needs-review and refuses direct retry", async () => {
    const f = await fixture(), p = await f.proposal(); f.behavior({ failBefore: true });
    const original = PluginPatchService.prototype.read; let reads = 0;
    vi.spyOn(PluginPatchService.prototype, "read").mockImplementation(function (this: PluginPatchService, selected, id, guard) {
      if (++reads === 2) return Promise.reject(Error("synthetic status read unavailable"));
      return original.call(this, selected, id, guard);
    });
    await f.controller.request({ kind: "patch-apply", ...owner, id: p.id });
    expect((await f.terminal(p.id)).proposal).toMatchObject({ status: "needs-review", message: expect.stringContaining("核对") });
    expect(await f.controller.request({ kind: "patch-apply", ...owner, id: p.id })).toMatchObject({ ok: false });
    expect(f.leases).toHaveLength(1);
    f.controller.dispose(); const restarted = createPluginDeliverableController(f.options); controllers.push(restarted);
    expect(good(await restarted.request({ kind: "patch-read", ...owner, id: p.id })).patch?.proposal.status).toBe("needs-review");
    expect(await restarted.request({ kind: "patch-apply", ...owner, id: p.id })).toMatchObject({ ok: false });
  });
  it("retries a refused uncertain-state marker on later reads without returning to retryable pending", async () => {
    const f = await fixture(), p = await f.proposal(); f.behavior({ failBefore: true });
    const read = PluginPatchService.prototype.read; let count = 0;
    vi.spyOn(PluginPatchService.prototype, "read").mockImplementation(function (this: PluginPatchService, selected, id, guard) {
      if (++count === 2) return Promise.reject(Error("synthetic unknown result")); return read.call(this, selected, id, guard);
    });
    const marking = vi.spyOn(PluginPatchService.prototype, "markNeedsReview").mockRejectedValueOnce(Error("synthetic storage refusal"));
    await f.controller.request({ kind: "patch-apply", ...owner, id: p.id });
    expect((await f.terminal(p.id)).proposal.status).toBe("needs-review");
    expect(marking.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, detached)).proposal.status).toBe("needs-review");
  });
  it("does not permanently block applies after one hundred completed outputs across owners", async () => {
    const f = await fixture();
    // Deliberately do not refresh manager result cards between writes: old
    // sessions' successful receipts must not fill an un-clearable global cache.
    for (let index = 0; index < 102; index++) {
      const selected: PluginOutputOwner = { scope: "workbench", target: "history-" + Math.floor(index / 40) };
      f.change({ id: selected.target, revision: index + 2 });
      const name = `output-${index}.txt`, p = await f.controller.createProposal(selected, f.producer, "run", { path: name, baseHash: null, content: "new" }, f.workspace, f.context(selected));
      expect(await f.controller.request({ kind: "patch-apply", ...selected, id: p.id })).toMatchObject({ ok: true });
      // Wait for the real service/lease to finish without polling manager cards
      // (which would clear UI receipts). No synthetic applied result is supplied.
      await until(async () => f.completedLeases(), count => count === index + 1);
      expect(await fs.readFile(join(f.workspace, name), "utf8")).toBe("new");
    }
    expect(f.leases).toHaveLength(102);
  }, 30000);
  it("keeps a real applied result when a wrapper throws after successful work", async () => {
    const f = await fixture(), p = await f.proposal(); f.behavior({ failAfter: true });
    await f.controller.request({ kind: "patch-apply", ...owner, id: p.id }); expect((await f.terminal(p.id)).proposal.status).toBe("applied");
    expect(await fs.readFile(join(f.workspace, p.path), "utf8")).toBe("new\n");
  });
  it("does not relabel a committed change when permissions change at publication", async () => {
    const f = await fixture(), p = await f.proposal(), original = nodefs.renameSync.bind(nodefs);
    vi.spyOn(nodefs, "renameSync").mockImplementation((from, to) => { original(from, to); if (String(to) === join(f.workspace, p.path)) f.change({ permissionRevision: 2 }); });
    await f.controller.request({ kind: "patch-apply", ...owner, id: p.id }); expect((await f.terminal(p.id)).proposal.status).toBe("applied");
  });
  it("dispose aborts only owned work and leaves an honest persistent cancellation", async () => {
    const f = await fixture(), p = await f.proposal(); f.hold(); await f.controller.request({ kind: "patch-apply", ...owner, id: p.id });
    await until(async () => f.approvals.length, count => count === 1); f.controller.dispose(); expect(f.leases[0]?.aborted).toBe(true);
    // Real session teardown waits for its workspace lease. Simulate reopening
    // only after that lease settles, not a second host reading an active store.
    await until(async () => f.completedLeases(), count => count === 1);
    const reader = new PluginPatchService({ profile: f.profile, protectedPaths: [] });
    const archived = await until(() => reader.read(owner, p.id, detached).catch(() => null), content => content?.proposal.status === "cancelled");
    expect(archived?.proposal.status).toBe("cancelled"); expect(await f.controller.request({ kind: "outputs-list", ...owner })).toMatchObject({ ok: false });
  });
});
