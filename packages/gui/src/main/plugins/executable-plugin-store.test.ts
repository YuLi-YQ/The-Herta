import { createHash, randomUUID } from "node:crypto";
import fsSync, { promises as fsPromises } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExecutablePluginPackage, type ExecutablePluginCapabilityName } from "../../shared/executable-plugins.js";
import type { ExecutablePluginManagementReply, ExecutablePluginPreview, ExecutablePluginSnapshot } from "../../shared/executable-plugin-management.js";
import { ExecutablePluginStore } from "./executable-plugin-store.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const directories: string[] = [];
const repairGuard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(randomUUID).mockImplementation((await vi.importActual<typeof import("node:crypto")>("node:crypto")).randomUUID);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function source(version = "1.0.0", id = "example.installed", capabilities: ExecutablePluginCapabilityName[] = ["storage.get", "log"]) {
  return {
    manifest: { schemaVersion: 2, apiVersion: 1, id, name: "安装夹具", version, description: "合成文件", entry: "main.js",
      capabilities: capabilities.map((name) => name === "network.request" ? { name, origins: ["https://example.invalid"], methods: ["GET"] } : { name }),
      actions: [{ id: "run", title: "运行", scope: "both", export: "run", inputs: [], capabilities }] },
    files: [{ path: "main.js", source: `export async function run() { return ${JSON.stringify(version)}; }` }],
  };
}
const checked = (reply: ExecutablePluginManagementReply): ExecutablePluginSnapshot => {
  if (!reply.ok) throw new Error(reply.message);
  return reply.snapshot;
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "herta-executable-plugin-")); directories.push(directory);
  const profile = join(directory, "profile"), input = join(directory, "input.json");
  await mkdir(profile); await writeFile(input, JSON.stringify(source()));
  let selected: string | undefined = input, clock = Date.parse("2026-11-01T00:00:00.000Z");
  const makeStore = (storage?: PluginStorageCoordinator) => new ExecutablePluginStore({ profileDir: profile, chooseFile: async () => selected, now: () => clock, storage });
  const store = makeStore(), root = join(profile, "plugins-v2"), index = join(root, "index.json"), blobs = join(root, "blobs");
  return { directory, profile, input, store, root, index, blobs, makeStore,
    select: (path?: string) => { selected = path; }, advance: (milliseconds: number) => { clock += milliseconds; } };
}
async function preview(store: ExecutablePluginStore): Promise<{ preview: ExecutablePluginPreview; snapshot: ExecutablePluginSnapshot }> {
  const reply = await store.request({ kind: "preview" });
  if (!reply.ok || !reply.preview) throw new Error(reply.ok ? "preview missing" : reply.message);
  return { preview: reply.preview, snapshot: reply.snapshot };
}
async function install(store: ExecutablePluginStore, grants: readonly ExecutablePluginCapabilityName[] = []) {
  const value = await preview(store);
  return checked(await store.request({ kind: "confirm", previewId: value.preview.id, revision: value.snapshot.revision, grants }));
}

describe("R145 frozen installation differences", () => {
  it("R146 requires dedicated generated confirmation before installing immutable frozen additions", async () => {
    const f = await fixture(), snapshot = checked(await f.store.request({ kind: "list" }));
    const pkg = source(), originalSource = pkg.files[0]!.source;
    const generated = await f.store.previewGenerated(JSON.stringify(pkg), snapshot.hostRevision, repairGuard());
    expect(generated.preview).toMatchObject({ source: "generated", baseContentHash: null, identical: false });
    expect(generated.snapshot.items).toHaveLength(0);
    await expect(readFile(f.index)).rejects.toMatchObject({ code: "ENOENT" });
    expect(generated.preview.changes.map(file => [file.path, file.change])).toEqual([["manifest.json", "added"], ["main.js", "added"]]);
    const module = generated.preview.changes[1]!;
    expect(module).toMatchObject({ before: null, after: originalSource, additions: 1, deletions: 0 });
    expect(module.diff).toContain("+" + originalSource);
    expect(JSON.parse(generated.preview.changes[0]!.after!)).toEqual(generated.preview.manifest);
    expect(Object.isFrozen(generated.preview.changes)).toBe(true); expect(Object.isFrozen(module)).toBe(true);
    pkg.files[0]!.source = "changed after generation";
    expect((await f.store.request({ kind: "confirm", previewId: generated.preview.id, revision: snapshot.revision, grants: [] })).ok).toBe(false);
    expect(checked(await f.store.request({ kind: "list" })).items).toHaveLength(0);
    const installed = checked(await f.store.confirmGenerated(generated.preview.id, snapshot.revision, [], snapshot.hostRevision, repairGuard()));
    const blob = JSON.parse(await readFile(join(f.blobs, installed.items[0]!.contentHash + ".json"), "utf8"));
    expect(blob.files[0].source).toBe(originalSource);
  });

  it("compares disabled installed content with added modified removed modules and the real rollback base", async () => {
    const f = await fixture(), original = source(); original.files.push({ path: "removed.js", source: "export const oldVersion = 1;\n" });
    await writeFile(f.input, JSON.stringify(original)); let current = await install(f.store);
    current = checked(await f.store.request({ kind: "enable", id: original.manifest.id, enabled: false, revision: current.revision }));
    const oldHash = current.items[0]!.contentHash;
    const updated = source("2.0.0", original.manifest.id, ["storage.get", "network.request"]);
    updated.files.push({ path: "new.js", source: "export const newVersion = 2;\n" }); await writeFile(f.input, JSON.stringify(updated));
    const next = await preview(f.store);
    expect(next.preview.existing?.enabled).toBe(false); expect(next.preview.baseContentHash).toBe(oldHash);
    expect(next.preview.changes.map(file => [file.path, file.change])).toEqual([
      ["manifest.json", "modified"], ["main.js", "modified"], ["new.js", "added"], ["removed.js", "removed"],
    ]);
    expect(next.preview.changes.find(file => file.path === "removed.js")).toMatchObject({ before: original.files[1]!.source, after: null, additions: 0, deletions: 1 });
    expect(next.preview.changes[0]!.diff).toContain('"network.request"');
    expect(next.preview.changes[0]!.after).toContain("https://example.invalid");
    current = checked(await f.store.request({ kind: "confirm", previewId: next.preview.id, revision: next.snapshot.revision, grants: [] }));
    expect(current.items[0]!.enabled).toBe(false);
    const rollback = await f.store.request({ kind: "rollback-preview", id: original.manifest.id, contentHash: oldHash, revision: current.revision });
    if (!rollback.ok || !rollback.preview) throw new Error("missing rollback");
    expect(rollback.preview.baseContentHash).toBe(current.items[0]!.contentHash);
    expect(rollback.preview.changes.find(file => file.path === "removed.js")).toMatchObject({ before: null, after: original.files[1]!.source, change: "added" });
    expect(rollback.preview.changes.find(file => file.path === "new.js")).toMatchObject({ after: null, change: "removed" });
  });

  it("rejects stale generated revision cancellation malformed content and a changed installation baseline", async () => {
    const f = await fixture(); let current = await install(f.store);
    await expect(f.store.previewGenerated(JSON.stringify(source("2.0.0")), current.hostRevision - 1, repairGuard())).rejects.toThrow("变化");
    await expect(f.store.previewGenerated('{"manifest":{}}', current.hostRevision, repairGuard())).rejects.toThrow("有效");
    const abort = new AbortController(); abort.abort();
    await expect(f.store.previewGenerated(JSON.stringify(source("2.0.0")), current.hostRevision, { signal: abort.signal, assertCurrent() {} })).rejects.toThrow("取消");
    const first = await f.store.previewGenerated(JSON.stringify(source("2.0.0")), current.hostRevision, repairGuard());
    current = checked(await f.store.request({ kind: "enable", id: current.items[0]!.manifest.id, enabled: false, revision: current.revision }));
    expect(await f.store.request({ kind: "confirm", previewId: first.preview.id, revision: current.revision, grants: [] })).toMatchObject({ ok: false });
    const next = await f.store.previewGenerated(JSON.stringify(source("2.0.0")), current.hostRevision, repairGuard()), index = await readFile(f.index, "utf8");
    await writeFile(join(f.blobs, current.items[0]!.contentHash + ".json"), "tampered baseline");
    expect(await f.store.request({ kind: "confirm", previewId: next.preview.id, revision: current.revision, grants: [] })).toMatchObject({ ok: false });
    expect(await readFile(f.index, "utf8")).toBe(index);
    await expect(readFile(join(f.blobs, next.preview.contentHash + ".json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
async function canonicalBlob(f: Awaited<ReturnType<typeof fixture>>, version = "2.0.0", id = "example.installed") {
  const pkg = parseExecutablePluginPackage(JSON.stringify(source(version, id))), text = JSON.stringify(pkg);
  const hash = createHash("sha256").update(text).digest("hex");
  await mkdir(f.blobs, { recursive: true }); await writeFile(join(f.blobs, `${hash}.json`), text);
  return { pkg, text, hash };
}

describe("R144 confirmed maintenance", () => {
  const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
  async function healthy() {
    const f = await fixture(); await install(f.store); await writeFile(f.input, JSON.stringify(source("2.0.0"))); await install(f.store); return f;
  }
  it("protects current, history, backup, archived references and live installation previews while deleting only an orphan", async () => {
    const f = await healthy(), archived = await canonicalBlob(f, "3.0.0"), pending = await canonicalBlob(f, "4.0.0"), orphan = await canonicalBlob(f, "5.0.0");
    const index = JSON.parse(await readFile(f.index, "utf8")); index.items[0] = { ...index.items[0], manifest: archived.pkg.manifest, contentHash: archived.hash, history: [] };
    const old = join(f.root, "damaged-" + randomUUID()); await mkdir(old); await writeFile(join(old, "index.json"), JSON.stringify(index));
    await writeFile(f.input, JSON.stringify(source("4.0.0"))); await preview(f.store);
    const view = await f.store.previewMaintenance(f.store.hostRevision, guard()), blobs = view.items.filter(item => item.category === "blob");
    expect(blobs).toHaveLength(1); expect(blobs[0]?.label).toContain(orphan.hash.slice(0, 12)); expect(view.protectedBlobCount).toBe(4);
    expect(JSON.stringify(view)).not.toContain(f.profile); expect(JSON.stringify(view)).not.toContain("export async");
    expect(await f.store.confirmMaintenance(view.id, [blobs[0]!.id], view.hostRevision, guard())).toMatchObject({ deletedCount: 1, retainedCount: 0, failedCount: 0, usageKnown: true });
    await expect(readFile(join(f.blobs, orphan.hash + ".json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.blobs, archived.hash + ".json"), "utf8")).toBe(archived.text);
    expect(await readFile(join(f.blobs, pending.hash + ".json"), "utf8")).toBe(pending.text);
    expect(await readdir(f.blobs)).toHaveLength(4);
  });
  it("deletes exact finished temp names including an internally accounted hard-link temp while retaining unknown names", async () => {
    const f = await healthy(), temp = join(f.root, "index.json.tmp-" + randomUUID()), unknown = join(f.root, "index.json.tmp-not-a-uuid");
    await writeFile(temp, "temporary-one"); await writeFile(unknown, "unknown-retained");
    const digest = "a".repeat(64), description = join(f.root, "isolated-blobs-link-" + digest + ".json");
    const linkedTemp = join(f.root, ".isolated-blobs-link-" + digest + "." + randomUUID() + ".tmp");
    await writeFile(description, "synthetic-description"); fsSync.linkSync(description, linkedTemp);
    const view = await f.store.previewMaintenance(f.store.hostRevision, guard()), temps = view.items.filter(item => item.category === "temporary");
    expect(temps).toHaveLength(2);
    expect(await f.store.confirmMaintenance(view.id, temps.map(item => item.id), view.hostRevision, guard())).toMatchObject({ deletedCount: 2, failedCount: 0 });
    expect(await readFile(unknown, "utf8")).toBe("unknown-retained"); expect(await readFile(description, "utf8")).toBe("synthetic-description");
    await expect(readFile(temp)).rejects.toMatchObject({ code: "ENOENT" }); await expect(readFile(linkedTemp)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("blocks orphan deletion on a corrupt retained index, then deletes only that explicit archive and requires a new orphan preview", async () => {
    const f = await healthy(), orphan = await canonicalBlob(f, "3.0.0"), damaged = join(f.root, "index.json.damaged-1700000000000-" + randomUUID());
    await writeFile(damaged, "{broken");
    const first = await f.store.previewMaintenance(f.store.hostRevision, guard());
    expect(first.items.some(item => item.category === "blob")).toBe(false);
    expect(first.blockedReasons.join(" ")).toContain("引用");
    const archive = first.items.find(item => item.category === "archive")!;
    expect(await f.store.confirmMaintenance(first.id, [archive.id], first.hostRevision, guard())).toMatchObject({ deletedCount: 1 });
    expect(await readFile(join(f.blobs, orphan.hash + ".json"), "utf8")).toBe(orphan.text);
    const next = await f.store.previewMaintenance(f.store.hostRevision, guard()); expect(next.items.filter(item => item.category === "blob")).toHaveLength(1);
  });
  it("performs zero deletions after any candidate, reference or live preview change", async () => {
    const f = await healthy(), a = await canonicalBlob(f, "3.0.0"), b = await canonicalBlob(f, "4.0.0");
    const first = await f.store.previewMaintenance(f.store.hostRevision, guard());
    const changedFile = join(f.blobs, b.hash + ".json"), stamp = fsSync.statSync(changedFile);
    fsSync.utimesSync(changedFile, stamp.atime, new Date(stamp.mtimeMs + 2000));
    await expect(f.store.confirmMaintenance(first.id, [first.items.find(item => item.label.includes(a.hash.slice(0, 12)))!.id], first.hostRevision, guard())).rejects.toMatchObject({ reason: "changed" });
    expect(await readFile(join(f.blobs, a.hash + ".json"), "utf8")).toBe(a.text);
    const contentPlan = await f.store.previewMaintenance(f.store.hostRevision, guard());
    await writeFile(changedFile, "changed-unselected-candidate");
    await expect(f.store.confirmMaintenance(contentPlan.id, [contentPlan.items[0]!.id], contentPlan.hostRevision, guard())).rejects.toMatchObject({ reason: "changed" });
    const second = await f.store.previewMaintenance(f.store.hostRevision, guard());
    await writeFile(f.input, JSON.stringify(source("5.0.0"))); await preview(f.store);
    await expect(f.store.confirmMaintenance(second.id, [second.items[0]!.id], second.hostRevision, guard())).rejects.toMatchObject({ reason: "changed" });
    const third = await f.store.previewMaintenance(f.store.hostRevision, guard());
    await writeFile(f.index + ".backup", (await readFile(f.index + ".backup", "utf8")) + "\n");
    await expect(f.store.confirmMaintenance(third.id, [third.items[0]!.id], third.hostRevision, guard())).rejects.toMatchObject({ reason: "changed" });
    expect(await readFile(join(f.blobs, a.hash + ".json"), "utf8")).toBe(a.text);
  });
  it("releases explicit old data while over budget and blobs is a junction, without touching targets, then permits a separate repair", async () => {
    const f = await fixture(), outside = join(f.directory, "outside"), archive = join(f.root, "damaged-" + randomUUID());
    await mkdir(outside); await writeFile(join(outside, "keep.txt"), "synthetic outside target");
    await mkdir(f.root); await writeFile(f.index, "{broken"); await symlink(outside, f.blobs, "junction");
    await mkdir(archive); await writeFile(join(archive, "old.bin"), Buffer.alloc(12000)); await symlink(outside, join(archive, "old-link"), "junction");
    await mkdir(join(f.profile, "plugin-data-v2")); await writeFile(join(f.profile, "plugin-data-v2", "retained.bin"), Buffer.alloc(512));
    const storage = new PluginStorageCoordinator(f.profile, { limitBytes: 8192 }), store = f.makeStore(storage);
    checked(await store.request({ kind: "list" }));
    await expect(storage.withWrite(0, guard(), async () => true)).rejects.toMatchObject({ reason: "unavailable" });
    const view = await store.previewMaintenance(store.hostRevision, guard());
    expect(view.usageKnown).toBe(false); expect(view.items.some(item => item.category === "blob")).toBe(false);
    const selected = view.items.find(item => item.category === "archive")!; expect(selected).toMatchObject({ bytes: 12000, linkCount: 1 });
    expect(await store.confirmMaintenance(view.id, [selected.id], view.hostRevision, guard())).toMatchObject({ deletedCount: 1, deletedBytes: 12000, usageKnown: false });
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("synthetic outside target");
    expect(fsSync.lstatSync(f.blobs).isSymbolicLink()).toBe(true);
    await expect(storage.withWrite(1, guard(), async () => true)).rejects.toMatchObject({ reason: "unavailable" });
    expect(checked(await store.request({ kind: "reset" })).items).toEqual([]);
    expect(fsSync.lstatSync(f.blobs).isSymbolicLink()).toBe(false);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("synthetic outside target");
  });
  it("reports actual completed items and bytes after a later deletion failure or cancellation", async () => {
    const f = await healthy();
    for (let i = 0; i < 2; i++) await writeFile(join(f.root, "index.json.tmp-" + randomUUID()), "temp");
    const view = await f.store.previewMaintenance(f.store.hostRevision, guard()), original = fsSync.unlinkSync.bind(fsSync); let count = 0;
    const failure = vi.spyOn(fsSync, "unlinkSync").mockImplementation(path => {
      if (++count === 2) throw Object.assign(new Error("synthetic failure"), { code: "EACCES" }); original(path);
    });
    const result = await f.store.confirmMaintenance(view.id, view.items.filter(item => item.category === "temporary").map(item => item.id), view.hostRevision, guard());
    failure.mockRestore(); expect(result).toMatchObject({ deletedCount: 1, deletedBytes: 4, retainedCount: 1, failedCount: 1, cancelled: false });
    await writeFile(join(f.root, "index.json.tmp-" + randomUUID()), "temp");
    const abort = new AbortController(), cancellationGuard = { signal: abort.signal, assertCurrent() {} };
    const next = await f.store.previewMaintenance(f.store.hostRevision, cancellationGuard);
    const cancellation = vi.spyOn(fsSync, "unlinkSync").mockImplementation(path => { original(path); abort.abort(); });
    const stopped = await f.store.confirmMaintenance(next.id, next.items.filter(item => item.category === "temporary").map(item => item.id), next.hostRevision, cancellationGuard);
    cancellation.mockRestore(); expect(stopped).toMatchObject({ deletedCount: 1, deletedBytes: 4, retainedCount: 1, failedCount: 0, cancelled: true });
  });
  it("exposes a pending file picker as busy and refuses maintenance without waiting for that operation", async () => {
    const f = await fixture(); let finish!: (path: string) => void, entered!: () => void;
    const selected = new Promise<string>(resolve => { finish = resolve; }), opened = new Promise<void>(resolve => { entered = resolve; });
    const store = new ExecutablePluginStore({ profileDir: f.profile, chooseFile: async () => { entered(); return selected; } });
    const pending = store.request({ kind: "preview" }); await opened;
    expect(store.isBusy).toBe(true);
    await expect(store.previewMaintenance(store.hostRevision, guard())).rejects.toMatchObject({ reason: "busy" });
    finish(f.input); expect((await pending).ok).toBe(true); expect(store.isBusy).toBe(false);
  });
});

describe("R142 shared storage budget for installations", () => {
  const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
  it("keeps the installed list and bytes when a new blob exceeds the global budget", async () => {
    const f = await fixture(); await install(f.store); const before = await readFile(f.index, "utf8");
    const baseline = await new PluginStorageCoordinator(f.profile).snapshot(guard());
    const limited = f.makeStore(new PluginStorageCoordinator(f.profile, { limitBytes: baseline.usedBytes }));
    await writeFile(f.input, JSON.stringify(source("2.0.0"))); const p = await preview(limited);
    const reply = await limited.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: [] });
    expect(reply).toMatchObject({ ok: false, message: expect.stringContaining("空间不足") });
    expect(await readFile(f.index, "utf8")).toBe(before);
    expect(checked(await limited.request({ kind: "list" })).items[0]?.manifest.version).toBe("1.0.0");
    expect(await readdir(f.blobs)).toHaveLength(1);
  });
  it("counts a newly retained orphan blob after backup admission fails without replacing the old index", async () => {
    const f = await fixture(); await install(f.store); const before = await readFile(f.index, "utf8");
    const packageText = JSON.stringify(parseExecutablePluginPackage(JSON.stringify(source("2.0.0"))));
    const baseline = await new PluginStorageCoordinator(f.profile).snapshot(guard());
    const storage = new PluginStorageCoordinator(f.profile, { limitBytes: baseline.usedBytes + Buffer.byteLength(packageText) });
    const limited = f.makeStore(storage); await writeFile(f.input, JSON.stringify(source("2.0.0"))); const p = await preview(limited);
    expect(await limited.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: [] }))
      .toMatchObject({ ok: false, message: expect.stringContaining("空间不足") });
    expect(await readFile(f.index, "utf8")).toBe(before);
    expect(await readFile(join(f.blobs, `${p.preview.contentHash}.json`), "utf8")).toBe(packageText);
    expect((await storage.snapshot(guard())).usedBytes).toBe(baseline.usedBytes + Buffer.byteLength(packageText));
    expect(checked(await limited.request({ kind: "list" })).damaged).toBeUndefined();
  });
  it("restores and resets damaged JSON through the shared lock without nested write deadlock", async () => {
    const f = await fixture(), storage = new PluginStorageCoordinator(f.profile), store = f.makeStore(storage);
    await install(store); await writeFile(f.input, JSON.stringify(source("2.0.0"))); await install(store);
    await writeFile(f.index, "{broken"); expect(checked(await store.request({ kind: "list" })).damaged).toBe(true);
    const restored = checked(await store.request({ kind: "restore" }));
    expect(restored.items[0]?.manifest.version).toBe("1.0.0"); expect(restored.items[0]?.enabled).toBe(false);
    await writeFile(f.index, "{broken-again"); expect(checked(await store.request({ kind: "list" })).damaged).toBe(true);
    expect(checked(await store.request({ kind: "reset" })).items).toEqual([]);
    expect((await readdir(f.root)).some(name => name.startsWith("damaged-"))).toBe(true);
    expect((await storage.snapshot(guard())).usedBytes).toBeGreaterThan(Buffer.byteLength(await readFile(f.index, "utf8")));
  }, 3000);
});

describe("v2 frozen preview and explicit installation", () => {
  it("loads a genuinely empty store without writing files or touching v1", async () => {
    const f = await fixture(); await writeFile(join(f.profile, "plugins-v1.json"), "v1 retained");
    const initial = checked(await f.store.request({ kind: "list" }));
    expect(initial).toEqual({ revision: 0, hostRevision: 1, items: [] });
    expect(f.store.current("example.installed")).toBeUndefined();
    expect(checked(await f.store.request({ kind: "list" })).hostRevision).toBe(initial.hostRevision);
    expect(await readdir(f.profile)).toEqual(["plugins-v1.json"]);
  });

  it("confirms the exact reviewed content even after the original file changes", async () => {
    const f = await fixture(), p = await preview(f.store);
    expect(p.preview.files[0]?.source).toContain("1.0.0");
    expect(p.preview.source).toBe("file"); expect(Object.isFrozen(p.preview.files)).toBe(true);
    await writeFile(f.input, JSON.stringify(source("2.0.0")));
    const snapshot = checked(await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: ["log"] }));
    const item = snapshot.items[0]!;
    expect(item.manifest.version).toBe("1.0.0"); expect(item.contentHash).toBe(p.preview.contentHash);
    expect(item.grantedCapabilities).toEqual([{ name: "log" }]); expect(item.grantRevision).toBe(1);
    expect(JSON.parse(await readFile(join(f.blobs, `${item.contentHash}.json`), "utf8")).files[0].source).toContain("1.0.0");
    const loaded = checked(await f.makeStore().request({ kind: "list" }));
    expect(loaded.items).toEqual(snapshot.items);
    expect(await readFile(f.input, "utf8")).toContain("2.0.0");
  });

  it("returns frozen cached items, not caller-editable grants or metadata", async () => {
    const f = await fixture(), snapshot = await install(f.store, ["storage.get"]), item = snapshot.items[0]!;
    expect(f.store.current(item.manifest.id)).toBe(item);
    expect(Object.isFrozen(item)).toBe(true); expect(Object.isFrozen(item.grantedCapabilities)).toBe(true);
    expect(() => Object.assign(item, { enabled: false })).toThrow();
    expect(() => (item.grantedCapabilities as unknown[]).push({ name: "commands.run" })).toThrow();
    await writeFile(f.index, "broken");
    expect(f.store.current(item.manifest.id)).toBe(item); // sync current does no disk I/O
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    expect(f.store.current(item.manifest.id)).toBeUndefined();
  });

  it("requires an explicit subset of declared capabilities and never auto-grants updates", async () => {
    const f = await fixture(), p = await preview(f.store);
    for (const grants of [["storage.get", "storage.get"], ["commands.run"], ["*"]]) {
      const reply = await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: grants as ExecutablePluginCapabilityName[] });
      expect(reply.ok).toBe(false);
    }
    const first = checked(await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: ["storage.get"] }));
    await writeFile(f.input, JSON.stringify(source("2.0.0", "example.installed", ["storage.get", "network.request"])));
    const second = await install(f.store, []);
    expect(second.items[0]?.grantedCapabilities).toEqual([]);
    expect(second.items[0]!.grantRevision).toBeGreaterThan(first.items[0]!.grantRevision);
  });

  it("grants a selected network capability exactly as reviewed", async () => {
    const f = await fixture(); await writeFile(f.input, JSON.stringify(source("1.0.0", "example.installed", ["network.request"])));
    const snapshot = await install(f.store, ["network.request"]);
    expect(snapshot.items[0]?.grantedCapabilities).toEqual([{ name: "network.request", origins: ["https://example.invalid"], methods: ["GET"] }]);
  });

  it("expires or discards previews without installing anything", async () => {
    const f = await fixture(), p = await preview(f.store); f.advance(600000);
    expect((await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: 0, grants: [] })).ok).toBe(false);
    const q = await preview(f.store); await f.store.request({ kind: "discard", previewId: q.preview.id });
    expect((await f.store.request({ kind: "confirm", previewId: q.preview.id, revision: 0, grants: [] })).ok).toBe(false);
    expect(checked(await f.store.request({ kind: "list" })).items).toEqual([]);
  });

  it("bounds retained previews and rejects replay after a successful confirmation", async () => {
    const f = await fixture(); const previews = [];
    for (let i = 0; i < 5; i++) previews.push(await preview(f.store));
    expect((await f.store.request({ kind: "confirm", previewId: previews[0]!.preview.id, revision: 0, grants: [] })).ok).toBe(false);
    const recent = previews[4]!;
    const installed = checked(await f.store.request({ kind: "confirm", previewId: recent.preview.id, revision: 0, grants: [] }));
    expect((await f.store.request({ kind: "confirm", previewId: recent.preview.id, revision: installed.revision, grants: [] })).ok).toBe(false);
  });

  it("treats a cancelled file picker as a no-op", async () => {
    const f = await fixture(); f.select(undefined);
    const reply = await f.store.request({ kind: "preview" });
    expect(reply).toEqual({ ok: true, snapshot: { revision: 0, hostRevision: 1, items: [] } });
  });

  it.each(["bad JSON", "non UTF-8", "oversized", "directory", "missing"])("rejects %s input with no source or path disclosure", async (kind) => {
    const f = await fixture();
    if (kind === "bad JSON") await writeFile(f.input, '{"secret":"private-value",');
    if (kind === "non UTF-8") await writeFile(f.input, Buffer.from([0xff, 0xfe, 0x7b]));
    if (kind === "oversized") await writeFile(f.input, " ".repeat(2 * 1024 * 1024 + 1));
    if (kind === "directory") f.select(f.directory);
    if (kind === "missing") f.select(join(f.directory, "private-location.json"));
    const reply = await f.store.request({ kind: "preview" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) { expect(reply.message).not.toContain("private"); expect(reply.message).not.toContain(f.directory); }
    expect(checked(await f.store.request({ kind: "list" })).items).toEqual([]);
  });

  it("accepts a UTF-8 BOM in a chosen source file but stores canonical bytes", async () => {
    const f = await fixture(); await writeFile(f.input, "\uFEFF" + JSON.stringify(source()));
    const installed = await install(f.store);
    expect((await readFile(join(f.blobs, `${installed.items[0]!.contentHash}.json`), "utf8")).startsWith("\uFEFF")).toBe(false);
  });
});

describe("serialized revisions, grants and version history", () => {
  it("serializes competing writes and keeps failed mutation state intact", async () => {
    const f = await fixture(), snapshot = await install(f.store), item = snapshot.items[0]!;
    const outcomes = await Promise.all([
      f.store.request({ kind: "enable", id: item.manifest.id, enabled: false, revision: snapshot.revision }),
      f.store.request({ kind: "remove", id: item.manifest.id, revision: snapshot.revision }),
    ]);
    expect(outcomes.map((reply) => reply.ok)).toEqual([true, false]);
    expect(f.store.current(item.manifest.id)?.enabled).toBe(false);
    expect(f.store.current(item.manifest.id)?.grantRevision).toBe(item.grantRevision + 1);
  });

  it("copies grants before queued requests can be mutated by the caller", async () => {
    const f = await fixture(), installed = await install(f.store), grants: ExecutablePluginCapabilityName[] = ["log"];
    const pending = f.store.request({ kind: "grants", id: "example.installed", grants, revision: installed.revision });
    grants.push("storage.get");
    expect(checked(await pending).items[0]?.grantedCapabilities).toEqual([{ name: "log" }]);
  });

  it("invalidates grants and observers on enable, disable, regrant, update and reinstall", async () => {
    const f = await fixture(), observer = vi.fn(); const unsubscribe = f.store.subscribe(observer);
    let snapshot = await install(f.store, ["log"]), item = snapshot.items[0]!;
    const revisions = [item.grantRevision], hostRevisions = [snapshot.hostRevision];
    for (const enabled of [false, true]) {
      snapshot = checked(await f.store.request({ kind: "enable", id: item.manifest.id, enabled, revision: snapshot.revision }));
      revisions.push(snapshot.items[0]!.grantRevision); hostRevisions.push(snapshot.hostRevision);
    }
    snapshot = checked(await f.store.request({ kind: "grants", id: item.manifest.id, grants: [], revision: snapshot.revision }));
    revisions.push(snapshot.items[0]!.grantRevision); hostRevisions.push(snapshot.hostRevision);
    await writeFile(f.input, JSON.stringify(source("2.0.0"))); snapshot = await install(f.store);
    revisions.push(snapshot.items[0]!.grantRevision); hostRevisions.push(snapshot.hostRevision);
    snapshot = await install(f.store); revisions.push(snapshot.items[0]!.grantRevision); hostRevisions.push(snapshot.hostRevision);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hostRevisions.every((revision, index) => index === 0 || revision > hostRevisions[index - 1]!)).toBe(true);
    expect(snapshot.items[0]?.history).toHaveLength(1);
    const calls = observer.mock.calls.length; unsubscribe(); await f.store.request({ kind: "remove", id: item.manifest.id, revision: snapshot.revision });
    expect(observer).toHaveBeenCalledTimes(calls);
  });

  it("keeps three historical versions plus active, and requires a new rollback confirmation/grant choice", async () => {
    const f = await fixture(); let snapshot = await install(f.store, ["log"]);
    for (let version = 2; version <= 5; version++) {
      f.advance(1000); await writeFile(f.input, JSON.stringify(source(`${version}.0.0`))); snapshot = await install(f.store, ["log"]);
    }
    const active = snapshot.items[0]!;
    expect(active.manifest.version).toBe("5.0.0"); expect(active.history.map((item) => item.version)).toEqual(["4.0.0", "3.0.0", "2.0.0"]);
    expect(await readdir(f.blobs)).toHaveLength(5); // evicted versions may still be referenced by backups
    const reply = await f.store.request({ kind: "rollback-preview", id: active.manifest.id, contentHash: active.history[0]!.contentHash, revision: snapshot.revision });
    if (!reply.ok || !reply.preview) throw new Error("rollback preview");
    expect(reply.preview.source).toBe("rollback"); expect(f.store.current(active.manifest.id)?.manifest.version).toBe("5.0.0");
    const rolled = checked(await f.store.request({ kind: "confirm", previewId: reply.preview.id, revision: reply.snapshot.revision, grants: [] }));
    expect(rolled.items[0]?.manifest.version).toBe("4.0.0"); expect(rolled.items[0]?.grantedCapabilities).toEqual([]);
    expect(rolled.items[0]?.history.map((item) => item.version)).toEqual(["5.0.0", "3.0.0", "2.0.0"]);
    expect(rolled.items[0]!.grantRevision).toBeGreaterThan(active.grantRevision);
  });

  it("retains disabled state across updates and rejects stale/out-of-scope run resolution", async () => {
    const f = await fixture(), first = await install(f.store), old = first.items[0]!;
    const resolved = await f.store.resolve(old.manifest.id, old.contentHash, "chat", "run"); expect(resolved.packageJson).toContain("1.0.0");
    await f.store.request({ kind: "enable", id: old.manifest.id, enabled: false, revision: first.revision });
    await writeFile(f.input, JSON.stringify(source("2.0.0"))); const next = await install(f.store);
    expect(next.items[0]?.enabled).toBe(false);
    await expect(f.store.resolve(old.manifest.id, old.contentHash, "chat", "run")).rejects.toThrow();
    await expect(f.store.resolve(old.manifest.id, next.items[0]!.contentHash, "chat", "run")).rejects.toThrow();
  });

  it("invalidates a preview on externally changed state even if its disk revision was not bumped", async () => {
    const f = await fixture(), first = await install(f.store), oldHost = first.hostRevision;
    await writeFile(f.input, JSON.stringify(source("2.0.0"))); const p = await preview(f.store);
    const raw = JSON.parse(await readFile(f.index, "utf8")); raw.items[0].enabled = false; await writeFile(f.index, JSON.stringify(raw));
    expect((await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: [] })).ok).toBe(false);
    expect(f.store.current("example.installed")?.enabled).toBe(false); expect(f.store.hostRevision).toBeGreaterThan(oldHost);
  });

  it("uninstalls without deleting the user's input file or archived blobs", async () => {
    const f = await fixture(), first = await install(f.store), item = first.items[0]!;
    const original = await readFile(f.input, "utf8");
    const removed = checked(await f.store.request({ kind: "remove", id: item.manifest.id, revision: first.revision }));
    expect(removed.items).toEqual([]); expect(f.store.current(item.manifest.id)).toBeUndefined();
    expect(await readFile(f.input, "utf8")).toBe(original); expect(await readdir(f.blobs)).toEqual([`${item.contentHash}.json`]);
    const reinstalled = await install(f.store); expect(reinstalled.items[0]!.grantRevision).toBeGreaterThan(item.grantRevision);
  });

  it("keeps the old cache/index when backup creation fails and does not consume a preview", async () => {
    const f = await fixture(), first = await install(f.store), oldItem = first.items[0]!;
    await mkdir(`${f.index}.backup`); await writeFile(f.input, JSON.stringify(source("2.0.0"))); const p = await preview(f.store);
    const previousBytes = await readFile(f.index, "utf8"), previousHost = f.store.hostRevision;
    expect((await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: [] })).ok).toBe(false);
    expect(await readFile(f.index, "utf8")).toBe(previousBytes); expect(f.store.current(oldItem.manifest.id)?.contentHash).toBe(oldItem.contentHash);
    expect(f.store.hostRevision).toBe(previousHost);
    await rm(`${f.index}.backup`, { recursive: true });
    expect(checked(await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: [] })).items[0]?.manifest.version).toBe("2.0.0");
    expect((await readdir(f.root)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("never deletes a pre-existing temporary file when exclusive backup creation collides", async () => {
    const f = await fixture(), installed = await install(f.store), original = await readFile(f.index, "utf8");
    const token = "11111111-1111-4111-8111-111111111111", collision = `${f.index}.backup.tmp-${token}`;
    await writeFile(collision, "not-owned-by-this-operation");
    vi.mocked(randomUUID).mockReturnValueOnce(token);
    expect((await f.store.request({ kind: "enable", id: "example.installed", enabled: false, revision: installed.revision })).ok).toBe(false);
    expect(await readFile(collision, "utf8")).toBe("not-owned-by-this-operation");
    expect(await readFile(f.index, "utf8")).toBe(original); expect(f.store.current("example.installed")?.enabled).toBe(true);
  });
});

describe("corruption, explicit recovery and storage boundaries", () => {
  it("marks malformed index damaged, preserves it, and restores disabled without old grants", async () => {
    const f = await fixture(), first = await install(f.store, ["log"]);
    const changed = checked(await f.store.request({ kind: "grants", id: "example.installed", grants: ["storage.get"], revision: first.revision }));
    const oldGrant = changed.items[0]!.grantRevision, oldHost = changed.hostRevision;
    const observer = vi.fn(); f.store.subscribe(observer);
    await writeFile(f.index, "private-corrupt-index"); const damaged = checked(await f.store.request({ kind: "list" }));
    expect(damaged.damaged).toBe(true); expect(f.store.current("example.installed")).toBeUndefined();
    const count = observer.mock.calls.length; await f.store.request({ kind: "list" }); expect(observer).toHaveBeenCalledTimes(count);
    const restored = checked(await f.store.request({ kind: "restore" }));
    expect(restored.items[0]?.enabled).toBe(false); expect(restored.items[0]?.grantedCapabilities).toEqual([]);
    expect(restored.items[0]!.grantRevision).toBeGreaterThan(oldGrant); expect(restored.hostRevision).toBeGreaterThan(oldHost);
    const saved = (await readdir(f.root)).find((name) => name.startsWith("index.json.damaged-"));
    expect(saved).toBeDefined(); expect(await readFile(join(f.root, saved!), "utf8")).toBe("private-corrupt-index");
  });

  it.each(["missing", "source", "newline", "bom"])("treats an active blob changed by %s as damaged", async (change) => {
    const f = await fixture(), snapshot = await install(f.store), item = snapshot.items[0]!, file = join(f.blobs, `${item.contentHash}.json`);
    const original = await readFile(file, "utf8");
    if (change === "missing") await rm(file);
    if (change === "source") await writeFile(file, original.replace("1.0.0", "2.0.0"));
    if (change === "newline") await writeFile(file, original + "\n");
    if (change === "bom") await writeFile(file, "\uFEFF" + original);
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    await expect(f.store.resolve(item.manifest.id, item.contentHash, "chat", "run")).rejects.toThrow();
    expect(f.store.current(item.manifest.id)).toBeUndefined();
  });

  it("checks historical blobs at rollback time and rejects missing or mismatched history", async () => {
    const f = await fixture(), first = await install(f.store); await writeFile(f.input, JSON.stringify(source("2.0.0"))); const second = await install(f.store);
    await rm(join(f.blobs, `${first.items[0]!.contentHash}.json`));
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBeUndefined();
    expect(checked(await f.makeStore().request({ kind: "list" })).damaged).toBe(true);
    expect((await f.store.request({ kind: "rollback-preview", id: "example.installed", contentHash: first.items[0]!.contentHash, revision: second.revision })).ok).toBe(false);
    expect(f.store.current("example.installed")).toBeUndefined();
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    expect((await f.store.request({ kind: "restore" })).ok).toBe(false);
    expect(checked(await f.store.request({ kind: "reset" })).items).toEqual([]);
  });

  it("keeps detected historical metadata damage visible until explicit recovery", async () => {
    const f = await fixture(), first = await install(f.store); await writeFile(f.input, JSON.stringify(source("2.0.0"))); await install(f.store);
    const raw = JSON.parse(await readFile(f.index, "utf8")); raw.items[0].history[0].version = "9.0.0"; await writeFile(f.index, JSON.stringify(raw));
    const loaded = checked(await f.store.request({ kind: "list" }));
    expect((await f.store.request({ kind: "rollback-preview", id: "example.installed", contentHash: first.items[0]!.contentHash, revision: loaded.revision })).ok).toBe(false);
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    expect(checked(await f.makeStore().request({ kind: "list" })).damaged).toBe(true);
    const restored = checked(await f.store.request({ kind: "restore" }));
    expect(restored.damaged).toBeUndefined(); expect(restored.items[0]?.enabled).toBe(false); expect(restored.items[0]?.manifest.version).toBe("1.0.0");
  });

  it("never turns a missing index with backup or orphan content into a new empty store", async () => {
    const f = await fixture(), first = await install(f.store);
    await f.store.request({ kind: "enable", id: "example.installed", enabled: false, revision: first.revision }); await rm(f.index);
    expect(checked(await f.makeStore().request({ kind: "list" })).damaged).toBe(true);
    const other = await fixture(); await canonicalBlob(other);
    expect(checked(await other.store.request({ kind: "list" })).damaged).toBe(true);
  });

  it("does not overwrite an existing mismatched content-addressed blob", async () => {
    const f = await fixture(); await install(f.store); await writeFile(f.input, JSON.stringify(source("2.0.0"))); const p = await preview(f.store);
    const target = join(f.blobs, `${p.preview.contentHash}.json`); await writeFile(target, "tampered");
    expect((await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: p.snapshot.revision, grants: [] })).ok).toBe(false);
    expect(await readFile(target, "utf8")).toBe("tampered"); expect(f.store.current("example.installed")).toBeUndefined();
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
  });

  it("explicit reset archives old index, backup and blobs and permits a safe same-hash reinstall", async () => {
    const f = await fixture(), first = await install(f.store, ["log"]), item = first.items[0]!;
    await f.store.request({ kind: "enable", id: item.manifest.id, enabled: false, revision: first.revision });
    await writeFile(join(f.blobs, `${item.contentHash}.json`), "corrupt-blob"); await writeFile(f.index, "corrupt-index");
    expect((await f.store.request({ kind: "restore" })).ok).toBe(false);
    const reset = checked(await f.store.request({ kind: "reset" }));
    expect(reset.damaged).toBeUndefined(); expect(reset.items).toEqual([]); expect(await readdir(f.blobs)).toEqual([]);
    const archive = (await readdir(f.root)).find((name) => name.startsWith("damaged-"))!;
    expect(await readFile(join(f.root, archive, "index.json"), "utf8")).toBe("corrupt-index");
    expect(await readFile(join(f.root, archive, "blobs", `${item.contentHash}.json`), "utf8")).toBe("corrupt-blob");
    expect(await readFile(join(f.root, archive, "index.json.backup"), "utf8")).toContain("example.installed");
    expect((await install(f.store)).items[0]?.contentHash).toBe(item.contentHash);
    expect(await readFile(f.input, "utf8")).toContain("1.0.0");
  });

  it("refuses restore/reset on a healthy store", async () => {
    const f = await fixture(); await install(f.store);
    expect((await f.store.request({ kind: "restore" })).ok).toBe(false); expect((await f.store.request({ kind: "reset" })).ok).toBe(false);
    expect(checked(await f.store.request({ kind: "list" })).items).toHaveLength(1);
  });

  it("keeps a colliding recovery temp and the damaged index without claiming a successful restore", async () => {
    const f = await fixture(), installed = await install(f.store);
    await f.store.request({ kind: "enable", id: "example.installed", enabled: false, revision: installed.revision });
    await writeFile(f.index, "corrupt-index");
    const token = "22222222-2222-4222-8222-222222222222", collision = `${f.index}.recovery-${token}`;
    await writeFile(collision, "unowned-recovery-temp"); vi.mocked(randomUUID).mockReturnValueOnce(token);
    expect((await f.store.request({ kind: "restore" })).ok).toBe(false);
    expect(await readFile(collision, "utf8")).toBe("unowned-recovery-temp"); expect(await readFile(f.index, "utf8")).toBe("corrupt-index");
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
  });

  it("does not claim reset succeeded when its archive cannot be created", async () => {
    const f = await fixture(), installed = await install(f.store), blob = join(f.blobs, `${installed.items[0]!.contentHash}.json`);
    const originalBlob = await readFile(blob, "utf8"); await writeFile(f.index, "corrupt-index");
    const tempToken = "33333333-3333-4333-8333-333333333333", archiveToken = "44444444-4444-4444-8444-444444444444";
    const collision = join(f.root, `damaged-${archiveToken}`); await writeFile(collision, "unowned-archive-path");
    vi.mocked(randomUUID).mockReturnValueOnce(tempToken).mockReturnValueOnce(archiveToken);
    expect((await f.store.request({ kind: "reset" })).ok).toBe(false);
    expect(await readFile(f.index, "utf8")).toBe("corrupt-index"); expect(await readFile(blob, "utf8")).toBe(originalBlob);
    expect(await readFile(collision, "utf8")).toBe("unowned-archive-path");
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    expect((await readdir(f.root)).some((name) => name.startsWith("index.json.recovery-"))).toBe(false);
  });

  it("rejects unsupported index schema, metadata/grants/history tampering and oversized index", async () => {
    const f = await fixture(); await install(f.store);
    const original = JSON.parse(await readFile(f.index, "utf8"));
    const changed = [
      (raw: any) => { raw.schemaVersion = 99; },
      (raw: any) => { raw.extra = true; },
      (raw: any) => { raw.items[0].contentHash = "../escape"; },
      (raw: any) => { raw.items[0].manifest.name = "not matching blob"; },
      (raw: any) => { raw.items[0].grantedCapabilities = [{ name: "commands.run" }]; },
      (raw: any) => { raw.items[0].history = [{ contentHash: raw.items[0].contentHash, version: "1.0.0", installedAt: raw.items[0].installedAt }]; },
      (raw: any) => { raw.items.push(raw.items[0]); },
    ];
    for (const edit of changed) {
      const raw = structuredClone(original); edit(raw); await writeFile(f.index, JSON.stringify(raw));
      expect(checked(await f.makeStore().request({ kind: "list" })).damaged).toBe(true);
    }
    await writeFile(f.index, " ".repeat(16 * 1024 * 1024 + 1));
    expect(checked(await f.makeStore().request({ kind: "list" })).damaged).toBe(true);
  });

  it("refuses to use a linked managed store directory or alter the outside target", async () => {
    const f = await fixture(), outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, f.root, "junction");
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    expect((await f.store.request({ kind: "reset" })).ok).toBe(false);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep"); expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it("describes a damaged blobs junction without retaining a live link or changing its outside target", async () => {
    const f = await fixture(); await install(f.store); await rm(f.blobs, { recursive: true });
    const outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, f.blobs, "junction");
    expect(checked(await f.store.request({ kind: "list" })).damaged).toBe(true);
    expect(checked(await f.store.request({ kind: "reset" })).items).toEqual([]);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep"); expect(await readdir(outside)).toEqual(["keep.txt"]);
    // R142's original failure is retained in store-junction-existing.log. The
    // repaired contract archives a plain description, never a live junction.
    const records = (await readdir(f.root)).filter(name => name.startsWith("isolated-blobs-link-"));
    expect(records).toHaveLength(1);
    const description = JSON.parse(await readFile(join(f.root, records[0]!), "utf8"));
    expect(description).toMatchObject({ kind: "untrusted-link-description", source: "plugins-v2/blobs", targetContents: "not-read" });
    expect(description.target).toContain("outside");
    expect((await fsPromises.lstat(f.blobs)).isSymbolicLink()).toBe(false);
    for (const name of (await readdir(f.root)).filter(name => name.startsWith("damaged-"))) {
      await expect(fsPromises.lstat(join(f.root, name, "blobs"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await new PluginStorageCoordinator(f.profile).snapshot(repairGuard())).toMatchObject({ status: "ready" });
    expect((await install(f.store)).items).toHaveLength(1);
  });

  it("R143 link repair preserves the original link and index when quota or description publication fails", async () => {
    for (const kind of ["quota", "publication"] as const) {
      const f = await fixture(); await install(f.store); const before = await readFile(f.index, "utf8"); await rm(f.blobs, { recursive: true });
      const outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep"); await symlink(outside, f.blobs, "junction");
      const originalTarget = await fsPromises.readlink(f.blobs);
      const store = kind === "quota" ? f.makeStore(new PluginStorageCoordinator(f.profile, { limitBytes: 1 })) : f.store;
      const actual = fsPromises.link;
      const failure = kind === "publication" ? vi.spyOn(fsPromises, "link").mockImplementation(async (source, target) => {
        if (String(target).includes("isolated-blobs-link-")) throw Object.assign(new Error("synthetic denied"), { code: "EACCES" });
        return actual(source, target);
      }) : undefined;
      try {
        expect(await store.request({ kind: "reset" })).toMatchObject({ ok: false, message: expect.stringContaining(kind === "quota" ? "空间不足" : "无法完整核对") });
      } finally { failure?.mockRestore(); }
      expect(await readFile(f.index, "utf8")).toBe(before); expect(await fsPromises.readlink(f.blobs)).toBe(originalTarget);
      expect((await readdir(f.root)).filter(name => name.startsWith("isolated-blobs-link-"))).toEqual([]);
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    }
  });

  it("R143 link repair reuses a published description after an unlink failure", async () => {
    const f = await fixture(); await install(f.store); const before = await readFile(f.index, "utf8"); await rm(f.blobs, { recursive: true });
    const outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep"); await symlink(outside, f.blobs, "junction");
    const actual = fsSync.unlinkSync;
    const failure = vi.spyOn(fsSync, "unlinkSync").mockImplementation(path => {
      if (String(path) === f.blobs) throw Object.assign(new Error("synthetic busy"), { code: "EBUSY" });
      return actual(path);
    });
    try {
      expect(await f.store.request({ kind: "reset" })).toMatchObject({ ok: false, message: expect.stringContaining("描述已保存，但隔离未完成") });
    } finally { failure.mockRestore(); }
    expect(await readFile(f.index, "utf8")).toBe(before); expect((await fsPromises.lstat(f.blobs)).isSymbolicLink()).toBe(true);
    const records = (await readdir(f.root)).filter(name => name.startsWith("isolated-blobs-link-")); expect(records).toHaveLength(1);
    expect(checked(await f.store.request({ kind: "reset" })).items).toEqual([]);
    expect((await readdir(f.root)).filter(name => name.startsWith("isolated-blobs-link-"))).toEqual(records);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await new PluginStorageCoordinator(f.profile).snapshot(repairGuard())).toMatchObject({ status: "ready" });
  });

  it("R143 reset can continue after link detachment when archive creation interrupted reconstruction", async () => {
    const f = await fixture(); await install(f.store); const before = await readFile(f.index, "utf8"); await rm(f.blobs, { recursive: true });
    const outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep"); await symlink(outside, f.blobs, "junction");
    const temp = "11111111-1111-4111-8111-111111111111", descriptionTemp = "22222222-2222-4222-8222-222222222222", archive = "33333333-3333-4333-8333-333333333333";
    await writeFile(join(f.root, `damaged-${archive}`), "archive collision retained");
    vi.mocked(randomUUID).mockReturnValueOnce(temp).mockReturnValueOnce(descriptionTemp).mockReturnValueOnce(archive);
    expect(await f.store.request({ kind: "reset" })).toMatchObject({ ok: false, message: expect.stringContaining("损坏链接已隔离") });
    expect(await readFile(f.index, "utf8")).toBe(before); await expect(fsPromises.lstat(f.blobs)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(f.root)).filter(name => name.startsWith("isolated-blobs-link-"))).toHaveLength(1);
    expect(checked(await f.store.request({ kind: "reset" })).items).toEqual([]);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await new PluginStorageCoordinator(f.profile).snapshot(repairGuard())).toMatchObject({ status: "ready" });
  });

  it("enforces the 50-plugin limit against a valid populated index", async () => {
    const f = await fixture(), installed = await install(f.store), base = installed.items[0]!;
    const items = [];
    for (let index = 0; index < 50; index++) {
      const entry = await canonicalBlob(f, "1.0.0", `example.plugin-${index}`);
      items.push({ ...base, manifest: entry.pkg.manifest, contentHash: entry.hash });
    }
    await writeFile(f.index, JSON.stringify({ schemaVersion: 1, revision: 2, items }));
    const full = checked(await f.store.request({ kind: "list" })); expect(full.items).toHaveLength(50);
    const p = await preview(f.store);
    expect((await f.store.request({ kind: "confirm", previewId: p.preview.id, revision: full.revision, grants: [] })).ok).toBe(false);
  }, 15000);
});
