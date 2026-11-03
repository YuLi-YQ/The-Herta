import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginRunResult } from "../../shared/plugin-runtime.js";
import type { PluginWorkshopDraft, PluginWorkshopReply } from "../../shared/plugin-workshop.js";
import { ExecutablePluginStore } from "./executable-plugin-store.js";
import { createPluginWorkshopController } from "./plugin-workshop-controller.js";
import type { PluginGeneratorInput, PluginGeneratorResult } from "./plugin-generator.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";
import type { PluginRuntimeService, PluginTask } from "./plugin-runtime-service.js";

vi.mock("../provider-settings.js", () => ({
  acquireChatProvider: vi.fn(() => { throw new Error("no real credentials"); }),
  getProviderSettings: vi.fn(() => { throw new Error("no personal profile"); }),
}));
const model = { providerId: "synthetic", modelId: "text-model", providerRevision: 1 };
const packageJson = JSON.stringify({ manifest: { schemaVersion: 2, apiVersion: 1, id: "local.workshop-controller",
  name: "合成工坊", description: "", version: "1.0.0", entry: "main.js", capabilities: [{ name: "log" }],
  actions: [{ id: "run", title: "运行", scope: "both", export: "run", inputs: [], capabilities: ["log"] },
    { id: "other", title: "另一动作", scope: "chat", export: "other", inputs: [], capabilities: [] }] },
  files: [{ path: "main.js", source: "export function run(){return 1;} export function other(){return 2;}" }] });
const target = (draft: PluginWorkshopDraft) => ({ id: draft.id, revision: draft.revision, contentHash: draft.contentHash });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function good(reply: PluginWorkshopReply) { expect(reply.ok).toBe(true); if (!reply.ok) throw Error(reply.message); return reply; }
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "herta-workshop-controller-")), profile = join(root, "profile");
  const storage = new PluginStorageCoordinator(profile, { limitBytes: 1024 * 1024 });
  const store = new ExecutablePluginStore({ profileDir: profile, storage, chooseFile: async () => undefined });
  await store.request({ kind: "list" });
  const generation = deferred<PluginGeneratorResult>(), generate = vi.fn((_input: PluginGeneratorInput) => generation.promise), generatorDispose = vi.fn();
  const result = deferred<PluginRunResult>(), closed = deferred<void>(), cancel = vi.fn(() => result.resolve({ ok: false, code: "cancelled" }));
  const start = vi.fn<PluginRuntimeService["start"]>(() => ({ id: "synthetic-process", accepted: true, result: result.promise, closed: closed.promise, cancel } satisfies PluginTask));
  let busy = false;
  const controller = createPluginWorkshopController({ profile, storage, store, runtime: { start }, isHostBusy: () => busy,
    generator: { generate, dispose: generatorDispose } });
  return { root, profile, store, controller, generation, generate, start, result, closed, cancel, generatorDispose,
    busy(value: boolean) { busy = value; },
    generated() { generation.resolve({ packageJson, ...model, outputBytes: Buffer.byteLength(packageJson) }); },
    async save(brief = "first") { return good(await controller.request({ kind: "workshop-save", target: null, brief, packageJson, model })).draft!; } };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, jobId: string) {
  let view = good(await f.controller.request({ kind: "workshop-status", jobId })).job!;
  await vi.waitFor(async () => { view = good(await f.controller.request({ kind: "workshop-status", jobId })).job!; expect(view.busy).toBe(false); });
  return view;
}

describe("R146 workshop controller", () => {
  it("strictly validates IPC and binds successful generated content to the exact explicit model", async () => {
    const f = await fixture(); let getterCalls = 0;
    expect((await f.controller.request({ kind: "workshop-generate", target: null, brief: "test", model, env: {} })).ok).toBe(false);
    expect((await f.controller.request({ get kind() { getterCalls++; return "workshop-list"; } })).ok).toBe(false);
    expect(getterCalls).toBe(0); expect(f.generate).not.toHaveBeenCalled();
    const started = good(await f.controller.request({ kind: "workshop-generate", target: null, brief: "explicit request", model })).job!;
    expect(started).toMatchObject({ kind: "generate", model, target: null, busy: true });
    expect(f.generate.mock.calls[0]![0]).toMatchObject({ requestId: started.id, brief: "explicit request", ...model });
    f.generated(); const done = await settled(f, started.id);
    expect(done.status).toBe("completed"); expect(done.draft?.model).toEqual(model);
    expect(good(await f.controller.request({ kind: "workshop-list" })).drafts?.items).toHaveLength(1);
    f.controller.dispose();
  });

  it("invalidates an in-flight generation when a newer edit saves, drops late output and preserves newer bytes", async () => {
    const f = await fixture(), original = await f.save();
    const started = good(await f.controller.request({ kind: "workshop-generate", target: target(original), brief: "regenerate", model })).job!;
    expect(f.generate.mock.calls[0]![0].previousPackageJson).toBe(original.packageJson);
    const edited = good(await f.controller.request({ kind: "workshop-save", target: target(original), brief: "new manual edit", packageJson, model })).draft!;
    expect(edited.revision).toBe(2); f.generated();
    expect((await settled(f, started.id)).status).toBe("cancelled");
    expect(good(await f.controller.request({ kind: "workshop-get", id: edited.id })).draft?.brief).toBe("new manual edit");
    expect((await f.controller.request({ kind: "workshop-save", target: target(original), brief: "stale", packageJson, model })).ok).toBe(false);
    f.controller.dispose();
  });

  it("retains trial occupancy through closed, freezes its input and marks other actions not-run", async () => {
    const f = await fixture(), draft = await f.save();
    const request = { kind: "workshop-trial", target: target(draft), actionId: "run", scope: "chat", inputJson: "{}", fixturesJson: "{}" };
    const started = good(await f.controller.request(request)).job!; request.actionId = "other";
    expect(f.start.mock.calls[0]![0]).toMatchObject({ packageJson: draft.packageJson, actionId: "run", inputJson: "{}" });
    f.result.resolve({ ok: true, valueJson: "1" });
    await vi.waitFor(async () => { expect(good(await f.controller.request({ kind: "workshop-status", jobId: started.id })).job?.status).toBe("completed"); });
    expect(f.controller.isBusy).toBe(true);
    expect((await f.controller.request({ kind: "workshop-generate", target: target(draft), brief: "blocked", model })).ok).toBe(false);
    f.closed.resolve(); const done = await settled(f, started.id);
    expect(done.trial).toMatchObject({ actionId: "run", simulated: true, externalEnvironmentVerified: false, contentHash: draft.contentHash, sourceHash: draft.contentHash });
    const preview = good(await f.controller.request({ kind: "workshop-preview", target: target(draft), hostRevision: f.store.hostRevision })).installation!;
    expect(preview.actions).toEqual([expect.objectContaining({ actionId: "run", state: "completed" }), { actionId: "other", state: "not-run" }]);
    f.controller.dispose();
  });

  it("binds installation to the draft and actual baseline, invalidates stale previews and passes explicit empty grants", async () => {
    const f = await fixture(), draft = await f.save();
    const first = good(await f.controller.request({ kind: "workshop-preview", target: target(draft), hostRevision: f.store.hostRevision })).installation!;
    expect(first.preview.baseContentHash).toBe(null); expect(first.actions.every(item => item.state === "not-run")).toBe(true);
    const changed = good(await f.controller.request({ kind: "workshop-save", target: target(draft), brief: "new revision", packageJson, model })).draft!;
    expect((await f.controller.request({ kind: "workshop-install", target: target(draft), previewId: first.preview.id, hostRevision: first.hostRevision, revision: first.revision, grants: [] })).ok).toBe(false);
    const second = good(await f.controller.request({ kind: "workshop-preview", target: target(changed), hostRevision: f.store.hostRevision })).installation!;
    const originalConfirm = f.store.confirmGenerated.bind(f.store);
    const captureGuard = vi.spyOn(f.store, "confirmGenerated").mockImplementation(async (...args) => {
      good(await f.controller.request({ kind: "workshop-discard", previewId: second.preview.id }));
      expect(() => args[4].assertCurrent()).toThrow();
      return originalConfirm(...args);
    });
    try {
      expect((await f.controller.request({ kind: "workshop-install", target: target(changed), previewId: second.preview.id, hostRevision: second.hostRevision, revision: second.revision, grants: [] })).ok).toBe(false);
    } finally { captureGuard.mockRestore(); }
    expect(f.store.current("local.workshop-controller")).toBeUndefined();
    const fresh = good(await f.controller.request({ kind: "workshop-preview", target: target(changed), hostRevision: f.store.hostRevision })).installation!;
    const installed = good(await f.controller.request({ kind: "workshop-install", target: target(changed), previewId: fresh.preview.id, hostRevision: fresh.hostRevision, revision: fresh.revision, grants: [] }));
    expect(installed.snapshot?.items[0]?.grantedCapabilities).toEqual([]);
    const third = good(await f.controller.request({ kind: "workshop-preview", target: target(changed), hostRevision: f.store.hostRevision })).installation!;
    await f.store.request({ kind: "enable", id: "local.workshop-controller", enabled: false, revision: third.revision });
    expect((await f.controller.request({ kind: "workshop-install", target: target(changed), previewId: third.preview.id, hostRevision: third.hostRevision, revision: third.revision, grants: [] })).ok).toBe(false);
    f.controller.dispose();
  });

  it("scopes cancel/discard tokens, blocks external busy state and disposes only owned generation/trials", async () => {
    const f = await fixture(), draft = await f.save();
    f.busy(true); expect((await f.controller.request({ kind: "workshop-trial", target: target(draft), actionId: "run", scope: "chat", inputJson: "{}" })).ok).toBe(false);
    f.busy(false);
    const preview = good(await f.controller.request({ kind: "workshop-preview", target: target(draft), hostRevision: f.store.hostRevision })).installation!;
    const started = good(await f.controller.request({ kind: "workshop-generate", target: target(draft), brief: "new", model })).job!;
    good(await f.controller.request({ kind: "workshop-discard", previewId: preview.preview.id }));
    expect(good(await f.controller.request({ kind: "workshop-status", jobId: started.id })).job?.status).toBe("running");
    expect((await f.controller.request({ kind: "workshop-cancel", jobId: draft.id })).ok).toBe(false);
    good(await f.controller.request({ kind: "workshop-cancel", jobId: started.id })); f.generated();
    expect((await settled(f, started.id)).status).toBe("cancelled");
    f.controller.dispose(); expect(f.generatorDispose).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled(); expect((await f.controller.request({ kind: "workshop-list" })).ok).toBe(false);
    expect(JSON.parse(await fs.readFile(join(f.profile, "plugin-workshop-v1", draft.id, "draft.json"), "utf8")).revision).toBe(1);
  });
});

