import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPluginStorageCoordinator, PluginStorageCoordinator, type PluginStorageGuard } from "./plugin-storage-coordinator.js";

const roots: string[] = [];
const releases: (() => void)[] = [];
function guard() { const abort = new AbortController(); return { abort, value: { signal: abort.signal, assertCurrent() {} } satisfies PluginStorageGuard }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve }; }
async function fixture(limitBytes = 1024) {
  const root = await fs.mkdtemp(join(tmpdir(), "herta-plugin-budget-")); roots.push(root);
  const profile = join(root, "profile"); await fs.mkdir(profile);
  return { root, profile, coordinator: new PluginStorageCoordinator(profile, { limitBytes }), ...guard() };
}
async function file(profile: string, path: string, bytes: number) {
  const target = join(profile, path); await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.alloc(bytes, 120)); return target;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("herta-plugin-budget-")
      || (await fs.lstat(absolute)).isSymbolicLink()) throw new Error("Unsafe synthetic cleanup");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe("unified plugin storage budget", () => {
  it("R143 blobs link repair rejects other unknown links and keeps repair plus reset in the shared queue", async () => {
    const f = await fixture(8192), outside = join(f.root, "outside"); await fs.mkdir(outside);
    await file(f.profile, "plugins-v2/index.json", 10); await fs.writeFile(join(outside, "keep.txt"), "outside retained");
    await fs.symlink(outside, join(f.profile, "plugins-v2/blobs"), process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(outside, join(f.profile, "plugin-data-v2"), process.platform === "win32" ? "junction" : "dir");
    const blocked = vi.fn(async () => {});
    await expect(f.coordinator.withBlobsLinkRepair(1, f.value, blocked)).rejects.toMatchObject({ reason: "unavailable" });
    expect(blocked).not.toHaveBeenCalled(); expect((await fs.lstat(join(f.profile, "plugins-v2/blobs"))).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(join(f.profile, "plugins-v2"))).filter(name => name.startsWith("isolated-blobs-link-"))).toEqual([]);
    await fs.unlink(join(f.profile, "plugin-data-v2"));
    const entered = deferred(), held = deferred();
    const repair = f.coordinator.withBlobsLinkRepair(1, f.value, async () => {
      entered.resolve(); await held.promise; await file(f.profile, "plugin-data-v2/value.json", 1); return "reset committed";
    });
    await entered.promise;
    let scanned = false; const waiting = f.coordinator.snapshot(f.value).then(value => { scanned = true; return value; });
    await Promise.resolve(); expect(scanned).toBe(false);
    held.resolve(); expect(await repair).toBe("reset committed");
    const snapshot = await waiting; expect(snapshot.status).toBe("ready"); expect(snapshot.usedBytes).toBeGreaterThan(11);
    expect(await fs.readFile(join(outside, "keep.txt"), "utf8")).toBe("outside retained");
    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    await expect(fs.lstat(join(f.profile, "plugins-v2/blobs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serializes cross-namespace contenders and snapshots at the last available bytes", async () => {
    const f = await fixture(10), held = deferred(), entered = deferred(), loser = vi.fn(async () => {});
    await file(f.profile, "plugins-v2/index.json", 5);
    const first = f.coordinator.withWrite(5, f.value, async () => {
      entered.resolve(); await held.promise; await file(f.profile, "plugin-data-v2/data.json", 5); return "committed";
    });
    await entered.promise;
    const other = new PluginStorageCoordinator(join(f.profile, "."), { limitBytes: 10 });
    const second = other.withWrite(1, f.value, loser).catch(error => error);
    let observed = false; const snapshot = f.coordinator.snapshot(f.value).then(value => { observed = true; return value; });
    await Promise.resolve(); expect(loser).not.toHaveBeenCalled(); expect(observed).toBe(false);
    held.resolve(); expect(await first).toBe("committed"); expect(await second).toMatchObject({ reason: "limit" });
    expect(await snapshot).toMatchObject({ usedBytes: 10, availableBytes: 0, fileCount: 2, overLimit: false });
    expect(loser).not.toHaveBeenCalled();
    expect(getPluginStorageCoordinator(f.profile)).toBe(getPluginStorageCoordinator(join(f.profile, ".")));
  });

  it("counts backup, archives, temporaries and proven internal hard links without reading contents", async () => {
    const f = await fixture();
    for (const [path, bytes] of [["plugins-v2/index.json", 3], ["plugins-v2/index.json.backup", 5], ["plugins-v2/blobs/a.json", 7],
      ["plugins-v2/damaged-old/blobs/b.json", 11], ["plugin-data-v2/id.json", 13], ["plugin-data-v2/.id.tmp", 17],
      ["plugin-artifacts-v1/owner/file.json", 19], ["plugin-patches-v2/owner/proposal.json", 23]] as const) await file(f.profile, path, bytes);
    await fs.link(join(f.profile, "plugin-artifacts-v1/owner/file.json"), join(f.profile, "plugin-patches-v2/owner/link.json"));
    await file(f.profile, "outside-plugin-namespaces/personal-placeholder", 1000);
    const read = vi.spyOn(fs, "readFile"), snapshot = await f.coordinator.snapshot(f.value);
    expect(snapshot).toMatchObject({ status: "ready", usedBytes: 117, fileCount: 9, categories: [
      { id: "packages", usedBytes: 26, fileCount: 4 }, { id: "private-data", usedBytes: 30, fileCount: 2 },
      { id: "artifacts", usedBytes: 19, fileCount: 1 }, { id: "proposals", usedBytes: 42, fileCount: 2 },
    ] });
    expect(read).not.toHaveBeenCalled(); expect(JSON.stringify(snapshot)).not.toContain(f.profile);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.categories[0])).toBe(true);
  });

  it("releases failures, recounts residue after restart, and rejects queued cancellation without masking a committed result", async () => {
    const f = await fixture(20), failure = new Error("synthetic failure");
    await expect(f.coordinator.withWrite(5, f.value, async () => {
      await file(f.profile, "plugins-v2/residue.tmp", 5); throw failure;
    })).rejects.toBe(failure);
    const restarted = new PluginStorageCoordinator(f.profile, { limitBytes: 20 });
    expect(await restarted.snapshot(f.value)).toMatchObject({ usedBytes: 5 });
    const held = deferred(), entered = deferred(), cancelled = guard(), notCalled = vi.fn(async () => {});
    const first = restarted.withWrite(3, f.value, async () => {
      entered.resolve(); await held.promise; await file(f.profile, "plugin-data-v2/value.json", 3);
      f.abort.abort(); return "already committed";
    });
    await entered.promise;
    const queued = restarted.withWrite(1, cancelled.value, notCalled).catch(error => error); cancelled.abort.abort(); held.resolve();
    expect(await first).toBe("already committed"); expect(await queued).toMatchObject({ reason: "cancelled" });
    expect(notCalled).not.toHaveBeenCalled();
    expect(await new PluginStorageCoordinator(f.profile, { limitBytes: 20 }).snapshot(guard().value)).toMatchObject({ usedBytes: 8 });
  });

  it("refuses a junction or a hard link whose other name is outside the owned namespaces", async () => {
    const f = await fixture(), outside = join(f.root, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, join(f.profile, "plugins-v2"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.coordinator.snapshot(f.value)).rejects.toMatchObject({ reason: "unavailable" });
    await fs.unlink(join(f.profile, "plugins-v2"));
    const source = await file(f.root, "outside/data.json", 7); await fs.mkdir(join(f.profile, "plugins-v2"));
    await fs.link(source, join(f.profile, "plugins-v2/unknown.json"));
    const write = vi.fn(async () => {});
    await expect(f.coordinator.withWrite(0, f.value, write)).rejects.toMatchObject({ reason: "unavailable" });
    expect(write).not.toHaveBeenCalled(); expect((await fs.stat(source)).size).toBe(7);
  });

  it("rejects a replaced profile and bounded traversal overflow instead of returning zero", async () => {
    const f = await fixture(); await file(f.profile, "plugins-v2/index.json", 1); await f.coordinator.snapshot(f.value);
    await fs.rename(f.profile, join(f.root, "old-profile")); await fs.mkdir(f.profile);
    await expect(f.coordinator.snapshot(f.value)).rejects.toMatchObject({ reason: "changed" });
    const deep = new PluginStorageCoordinator(f.profile);
    await file(f.profile, `plugins-v2/${Array(9).fill("nested").join("/")}/file.json`, 1);
    await expect(deep.snapshot(f.value)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("allows old over-limit data to be inspected and zero-growth maintenance while rejecting new growth", async () => {
    const f = await fixture(10); await file(f.profile, "plugin-artifacts-v1/owner/file.json", 12);
    expect(await f.coordinator.snapshot(f.value)).toMatchObject({ usedBytes: 12, limitBytes: 10, availableBytes: 0, overLimit: true });
    const write = vi.fn(async () => {});
    await expect(f.coordinator.withWrite(1, f.value, write)).rejects.toMatchObject({ reason: "limit" });
    expect(write).not.toHaveBeenCalled(); expect(await f.coordinator.withWrite(0, f.value, async () => "inspected" )).toBe("inspected");
    const missing = join(f.root, "new-profile"), empty = new PluginStorageCoordinator(missing, { limitBytes: 10 });
    expect(await empty.snapshot(f.value)).toMatchObject({ usedBytes: 0, fileCount: 0 });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    await empty.withWrite(2, f.value, async () => { await file(missing, "plugin-data-v2/new.json", 2); });
    expect(await empty.snapshot(f.value)).toMatchObject({ usedBytes: 2 });
  });
});
