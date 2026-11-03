import { createHash } from "node:crypto";
import nodefs from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginOutputOwner, PluginOutputProducer } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault } from "./capability-broker.js";
import { PLUGIN_PATCH_LIMITS, PluginPatchService, type PluginPatchGuard } from "./plugin-patch-service.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

const folders: string[] = [];
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const owner: PluginOutputOwner = { scope: "workbench", target: "fixture-session" };
const producer: PluginOutputProducer = { id: "example.patch", name: "Fixture patch", version: "1.0.0", contentHash: "a".repeat(64), grantRevision: 1 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), "herta-plugin-patch-")); folders.push(base);
  const root = join(base, "workspace"), profile = join(base, "profile"); await fs.mkdir(root); await fs.mkdir(profile);
  const abort = new AbortController(); let revoked = false;
  const guard: PluginPatchGuard = { signal: abort.signal, assertCurrent() { if (revoked) throw new PluginBrokerFault("revoked"); } };
  const service = new PluginPatchService({ profile, protectedPaths: [] });
  const dir = join(profile, "plugin-patches-v2", sha(JSON.stringify(owner)));
  return { base, root, profile, guard, abort, service, dir, revoke: () => { revoked = true; },
    file: (path = "file.txt") => join(root, path), record: (id: string) => join(dir, `${id}.json`),
    create: async (before: string | null = "old\n", after = "new\n", path = "file.txt") => {
      if (before !== null) { await fs.mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); await fs.writeFile(join(root, path), before); }
      return service.create(owner, producer, "fixture-run", { path, baseHash: before === null ? null : sha(before), content: after }, root, guard);
    },
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) {
    const absolute = resolve(folder);
    if (!isPathInside(resolve(tmpdir()), absolute, { strict: true }) || !basename(absolute).startsWith("herta-plugin-patch-")) throw new Error("Unsafe fixture cleanup");
    const info = await fs.lstat(absolute); if (info.isSymbolicLink()) throw new Error("Linked fixture cleanup refused");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe("persistent plugin workspace proposals", () => {
  it("R142 budget refuses an approved apply and status save before any temporary or workspace write", async () => {
    const f = await fixture(), p = await f.create(), original = await fs.readFile(f.record(p.id), "utf8");
    const storage = new PluginStorageCoordinator(f.profile, { limitBytes: 8192 });
    const used = (await storage.snapshot(f.guard)).usedBytes;
    await fs.mkdir(join(f.profile, "plugin-data-v2"));
    await fs.writeFile(join(f.profile, "plugin-data-v2", "other-plugin.json"), Buffer.alloc(8191 - used, 65));
    const service = new PluginPatchService({ profile: f.profile, protectedPaths: [], storage });
    const open = vi.spyOn(fs, "open"), authorize = vi.fn(async () => true);
    const result = await service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize });
    expect(authorize).toHaveBeenCalledOnce(); expect(result.proposal).toMatchObject({ status: "failed", message: expect.stringContaining("空间不足") });
    expect(open.mock.calls.some(call => call[1] === "wx")).toBe(false);
    expect(await fs.readFile(f.file(), "utf8")).toBe("old\n"); expect(await fs.readFile(f.record(p.id), "utf8")).toBe(original);
    expect(await fs.readdir(f.root)).toEqual(["file.txt"]); expect(await fs.readdir(f.dir)).toEqual([`${p.id}.json`]);
    await expect(service.cancel(owner, p.id, f.guard)).rejects.toMatchObject({ reason: "limit", code: "resource-limit" });
    expect(await fs.readFile(f.record(p.id), "utf8")).toBe(original);
  });

  it("R142 budget waits outside approval then holds one reservation through intent and completion", async () => {
    const f = await fixture(), p = await f.create(), storage = new PluginStorageCoordinator(f.profile, { limitBytes: 65536 });
    const service = new PluginPatchService({ profile: f.profile, protectedPaths: [], storage }), write = vi.spyOn(storage, "withWrite");
    const approvalEntered = deferred<void>(), approval = deferred<boolean>(), intentEntered = deferred<void>(), releaseIntent = deferred<void>();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const record = JSON.parse(await fs.readFile(from, "utf8"));
      if (record.content?.proposal?.status === "applying") { intentEntered.resolve(); await releaseIntent.promise; }
      return rename(from, to);
    });
    const applying = service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard,
      authorize: async () => { approvalEntered.resolve(); return approval.promise; } });
    await approvalEntered.promise;
    expect((await storage.snapshot(f.guard)).usedBytes).toBeGreaterThan(0);
    expect(write).not.toHaveBeenCalled(); // Approval does not own the shared mutex.
    approval.resolve(true); await intentEntered.promise;
    let snapshotCompleted = false;
    const during = storage.snapshot(f.guard).then(value => { snapshotCompleted = true; return value; });
    await Promise.resolve(); await Promise.resolve(); expect(snapshotCompleted).toBe(false);
    releaseIntent.resolve(); expect((await applying).proposal.status).toBe("applied");
    expect((await during).usedBytes).toBeGreaterThan(0); expect(write).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(f.file(), "utf8")).toBe("new\n");
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [], storage }).read(owner, p.id, f.guard)).proposal.status).toBe("applied");
  });

  it("R142 budget releases after committed cancellation and metadata failure without losing the commit receipt", async () => {
    const f = await fixture(), p = await f.create(), storage = new PluginStorageCoordinator(f.profile, { limitBytes: 65536 });
    const service = new PluginPatchService({ profile: f.profile, protectedPaths: [], storage }), write = vi.spyOn(storage, "withWrite");
    const renameSync = nodefs.renameSync.bind(nodefs), rename = fs.rename.bind(fs);
    vi.spyOn(nodefs, "renameSync").mockImplementation((from, to) => { renameSync(from, to); f.abort.abort(); });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      const record = JSON.parse(await fs.readFile(from, "utf8"));
      if (record.content?.proposal?.status === "applied") throw Error("synthetic metadata write failure");
      return rename(from, to);
    });
    const result = await service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal).toMatchObject({ status: "applied", message: expect.stringContaining("文件已写入") });
    expect(await fs.readFile(f.file(), "utf8")).toBe("new\n"); expect(write).toHaveBeenCalledTimes(1);
    const detached: PluginPatchGuard = { signal: new AbortController().signal, assertCurrent() {} };
    expect((await storage.snapshot(detached)).status).toBe("ready");
    expect((await service.read(owner, p.id, detached)).proposal.status).toBe("applied");
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [], storage }).read(owner, p.id, detached)).proposal.status).toBe("needs-review");
    expect(await fs.readdir(f.dir)).toEqual([`${p.id}.json`]);
  });

  it("stages frozen actual before/after/diff without touching the workspace and survives restart", async () => {
    const f = await fixture(), p = await f.create();
    expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
    const read = await f.service.read(owner, p.id, f.guard);
    expect(read).toMatchObject({ before: "old\n", after: "new\n", proposal: { status: "pending", baseHash: sha("old\n"), nextHash: sha("new\n"), additions: 1, deletions: 1 } });
    expect(read.diff).toContain("-old"); expect(read.diff).toContain("+new"); expect(Object.isFrozen(read.proposal.producer)).toBe(true);
    expect(await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, f.guard)).toEqual(read);
  });
  it("takes owned copies of caller input before asynchronous staging", async () => {
    const f = await fixture(), input = { path: "new.txt", baseHash: null, content: "accepted" }, source = { ...producer };
    const pending = f.service.create(owner, source, "fixture-run", input, f.root, f.guard); input.content = "changed"; source.name = "changed";
    const p = await pending, read = await f.service.read(owner, p.id, f.guard);
    expect(read.after).toBe("accepted"); expect(read.proposal.producer.name).toBe(producer.name);
  });
  it("isolates owner namespaces and denies chat scope", async () => {
    const f = await fixture(), p = await f.create(), other = { ...owner, target: "other-session" };
    expect(await f.service.list(other, f.guard)).toEqual({ items: [], damagedCount: 0 });
    await expect(f.service.read(other, p.id, f.guard)).rejects.toBeDefined();
    await expect(f.service.create({ scope: "chat", target: "chat" }, producer, "run", { path: "x", baseHash: null, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ reason: "invalid-input" });
  });
  it("matches raw bytes including BOM and preserves an existing BOM in new bytes", async () => {
    const f = await fixture(), p = await f.create("\uFEFF原文\r\n", "新文\r\n");
    const read = await f.service.read(owner, p.id, f.guard);
    expect(read.before).toBe("\uFEFF原文\r\n"); expect(read.after).toBe("\uFEFF新文\r\n"); expect(p.nextHash).toBe(sha("\uFEFF新文\r\n"));
    const applied = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(applied.proposal.status).toBe("applied"); expect(await fs.readFile(f.file(), "utf8")).toBe("\uFEFF新文\r\n");
  });
  it.each(["../outside", "/absolute", "a\\b", "C:/outside", "name:stream", "NUL.txt", "sub/COM1", "bad.", "bad "])("rejects nonportable path %s", async path => {
    const f = await fixture();
    await expect(f.service.create(owner, producer, "run", { path, baseHash: null, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ reason: "invalid-input" });
  });
  it.each([".env", ".git/config", ".herta/permissions.json", ".ssh/id_rsa"])("denies protected path %s before staging", async path => {
    const f = await fixture();
    await expect(f.service.create(owner, producer, "run", { path, baseHash: null, content: "fixture" }, f.root, f.guard)).rejects.toMatchObject({ code: "capability-denied" });
    expect(await f.service.list(owner, f.guard)).toEqual({ items: [], damagedCount: 0 });
  });
  it("denies an application profile inside the project and junction paths", async () => {
    const f = await fixture(), inside = join(f.root, "profile"); await fs.mkdir(inside);
    const service = new PluginPatchService({ profile: inside, protectedPaths: [] });
    await expect(service.create(owner, producer, "run", { path: "profile/file", baseHash: null, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ code: "capability-denied" });
    const outside = join(f.base, "outside"); await fs.mkdir(outside); await fs.symlink(outside, join(f.root, "jump"), "junction");
    await expect(f.service.create(owner, producer, "run", { path: "jump/file", baseHash: null, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ code: "capability-denied" });
  });
  it("rejects stale base hashes and null-base overwrites at proposal creation", async () => {
    const f = await fixture(); await fs.writeFile(f.file(), "present");
    for (const baseHash of [null, sha("other")]) await expect(f.service.create(owner, producer, "run", { path: "file.txt", baseHash, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ reason: "conflict" });
    expect(await fs.readFile(f.file(), "utf8")).toBe("present");
  });
  it.each([Buffer.from([0xff]), Buffer.from([65, 0]), Buffer.alloc(PLUGIN_PATCH_LIMITS.originalBytes + 1, 65)])("refuses unsupported or oversized original bytes", async bytes => {
    const f = await fixture(); await fs.writeFile(f.file(), bytes);
    await expect(f.service.create(owner, producer, "run", { path: "file.txt", baseHash: sha(bytes), content: "replacement" }, f.root, f.guard)).rejects.toBeDefined();
    expect(await fs.readFile(f.file())).toEqual(bytes);
  });
  it("reports damaged records alongside valid proposals without deleting either", async () => {
    const f = await fixture(), p = await f.create(); await fs.writeFile(join(f.dir, "broken.json"), "{broken");
    const list = await f.service.list(owner, f.guard); expect(list.items.map(x => x.id)).toEqual([p.id]); expect(list.damagedCount).toBe(1);
    expect(await fs.readFile(join(f.dir, "broken.json"), "utf8")).toBe("{broken");
    const raw = JSON.parse(await fs.readFile(f.record(p.id), "utf8")); raw.content.after = "tampered"; await fs.writeFile(f.record(p.id), JSON.stringify(raw));
    expect((await f.service.list(owner, f.guard)).damagedCount).toBe(2);
    await expect(f.service.read(owner, p.id, f.guard)).rejects.toMatchObject({ reason: "damaged" });
  });
  it("refuses a linked private store directory", async () => {
    const f = await fixture(), outside = join(f.base, "outside"); await fs.mkdir(outside); await fs.symlink(outside, join(f.profile, "plugin-patches-v2"), "junction");
    await expect(f.create()).rejects.toMatchObject({ reason: "unavailable" }); expect(await fs.readdir(outside)).toEqual([]);
  });
  it("enforces the proposal count and counts orphan storage toward the byte budget", async () => {
    const f = await fixture();
    for (let n = 0; n < 50; n++) await f.service.create(owner, producer, "run", { path: `new-${n}`, baseHash: null, content: "x" }, f.root, f.guard);
    await expect(f.service.create(owner, producer, "run", { path: "overflow", baseHash: null, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ reason: "limit" });
    expect((await f.service.list(owner, f.guard)).items).toHaveLength(50);
    const other = await fixture(); await other.create(); await fs.writeFile(join(other.dir, "orphan.tmp"), Buffer.alloc(PLUGIN_PATCH_LIMITS.ownerBytes));
    await expect(other.service.create(owner, producer, "run", { path: "next", baseHash: null, content: "x" }, other.root, other.guard)).rejects.toMatchObject({ reason: "limit" });
  });
  it("does not delete a foreign exclusive-temp collision", async () => {
    const f = await fixture(), original = fs.open.bind(fs); let collision = "";
    vi.spyOn(fs, "open").mockImplementation(async (p, flags, mode) => {
      if (flags === "wx") { collision = String(p); await fs.writeFile(collision, "foreign"); throw Object.assign(new Error("collision"), { code: "EEXIST" }); }
      return original(p, flags, mode);
    });
    await expect(f.create()).rejects.toBeDefined(); expect(await fs.readFile(collision, "utf8")).toBe("foreign");
  });
  it("bounds global storage including orphan files outside the current owner", async () => {
    const f = await fixture(); await f.create();
    const orphan = join(f.profile, "plugin-patches-v2", "orphan.bin"), file = await fs.open(orphan, "wx");
    await file.truncate(PLUGIN_PATCH_LIMITS.totalBytes); await file.close();
    await expect(f.service.create({ ...owner, target: "another-owner" }, producer, "run", { path: "other", baseHash: null, content: "x" }, f.root, f.guard)).rejects.toMatchObject({ reason: "limit" });
    expect((await fs.stat(orphan)).size).toBe(PLUGIN_PATCH_LIMITS.totalBytes);
  });
  it("does not silently recreate a profile whose directory identity changed", async () => {
    const f = await fixture(); await f.create(); await fs.rename(f.profile, `${f.profile}-old`); await fs.mkdir(f.profile);
    await expect(f.service.list(owner, f.guard)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await fs.readdir(f.profile)).toEqual([]);
  });
  it("persists full directory identifiers as decimal strings without Number precision loss", async () => {
    const f = await fixture(), p = await f.create(), info = await fs.lstat(f.root, { bigint: true });
    const record = JSON.parse(await fs.readFile(f.record(p.id), "utf8"));
    expect(record.rootIdentity).toEqual({ dev: info.dev.toString(), ino: info.ino.toString() });
  });
  it("returns a freshly published proposal even when temporary unlink first fails", async () => {
    const f = await fixture(), unlink = fs.unlink.bind(fs); let refused = false;
    vi.spyOn(fs, "unlink").mockImplementation(async path => {
      if (!refused && String(path).endsWith(".tmp")) { refused = true; throw Object.assign(new Error("fixture sharing error"), { code: "EBUSY" }); }
      return unlink(path);
    });
    const p = await f.create();
    expect(refused).toBe(true); expect((await f.service.read(owner, p.id, f.guard)).proposal.status).toBe("pending");
    expect(await fs.readdir(f.dir)).toEqual([`${p.id}.json`]); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it("returns a freshly published proposal when cancellation arrives after publication", async () => {
    const f = await fixture(), link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => { await link(from, to); f.abort.abort(); });
    const p = await f.create(); expect(f.guard.signal.aborted).toBe(true);
    const independent = { signal: new AbortController().signal, assertCurrent() {} };
    expect((await f.service.read(owner, p.id, independent)).proposal.status).toBe("pending");
    expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
});

describe("explicit proposal application", () => {
  it("requires explicit authorization and writes an immutable receipt only after actual apply", async () => {
    const f = await fixture(), p = await f.create(), authorize = vi.fn(async preview => {
      expect(preview.before).toBe("old\n"); expect(preview.after).toBe("new\n"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n"); return true;
    });
    const applied = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize });
    expect(authorize).toHaveBeenCalledOnce(); expect(applied.proposal).toMatchObject({ status: "applied", nextHash: sha("new\n") }); expect(applied.proposal.appliedAt).toBeDefined();
    expect(await fs.readFile(f.file(), "utf8")).toBe("new\n"); expect(await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, f.guard)).toEqual(applied);
    await expect(f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize })).rejects.toMatchObject({ reason: "conflict" });
    expect(authorize).toHaveBeenCalledOnce();
  });
  it("denial preserves the original and a new explicit retry can apply", async () => {
    const f = await fixture(), p = await f.create();
    const denied = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => false });
    expect(denied.proposal.status).toBe("denied"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
    expect((await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true })).proposal.status).toBe("applied");
  });
  it("supports cancelling a pending proposal without deleting its evidence", async () => {
    const f = await fixture(), p = await f.create(); expect((await f.service.cancel(owner, p.id, f.guard)).proposal.status).toBe("cancelled");
    expect((await f.service.read(owner, p.id, f.guard)).diff).toContain("-old"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it.each(["abort", "revoke"])("stops a late approved operation after %s", async mode => {
    const f = await fixture(), p = await f.create();
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => { if (mode === "abort") f.abort.abort(); else f.revoke(); return true; } });
    expect(result.proposal.status).toBe("cancelled"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it("conflicts before approval without offering a stale diff", async () => {
    const f = await fixture(), p = await f.create(); await fs.writeFile(f.file(), "user change"); const authorize = vi.fn(async () => true);
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize });
    expect(result.proposal.status).toBe("conflict"); expect(authorize).not.toHaveBeenCalled(); expect(await fs.readFile(f.file(), "utf8")).toBe("user change");
    await expect(f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize })).rejects.toMatchObject({ reason: "conflict" });
  });
  it("rechecks bytes after approval and never writes over intervening edits", async () => {
    const f = await fixture(), p = await f.create();
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => { await fs.writeFile(f.file(), "during approval"); return true; } });
    expect(result.proposal.status).toBe("conflict"); expect(await fs.readFile(f.file(), "utf8")).toBe("during approval");
  });
  it("performs a final synchronous base check after writing the owned temporary", async () => {
    const f = await fixture(), p = await f.create(), original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => { const handle = await original(path, flags, mode); if (flags === "wx" && basename(String(path)).startsWith(".herta-plugin-")) await fs.writeFile(f.file(), "before commit"); return handle; });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("conflict"); expect(await fs.readFile(f.file(), "utf8")).toBe("before commit"); expect(await fs.readdir(f.root)).toEqual(["file.txt"]);
  });
  it("creates missing parents after approval and publishes a new file without overwrite", async () => {
    const f = await fixture(), p = await f.create(null, "new content", "sub/new.txt"); expect(await fs.readdir(f.root)).toEqual([]);
    const applied = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(applied.proposal.status).toBe("applied"); expect(await fs.readFile(f.file("sub/new.txt"), "utf8")).toBe("new content"); expect(await fs.readdir(join(f.root, "sub"))).toEqual(["new.txt"]);
  });
  it("new-file publication refuses a racing creation at the final commit", async () => {
    const f = await fixture(), p = await f.create(null), link = nodefs.linkSync;
    vi.spyOn(nodefs, "linkSync").mockImplementation((from, to) => { nodefs.writeFileSync(to, "racer", { flag: "wx" }); link(from, to); });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("conflict"); expect(await fs.readFile(f.file(), "utf8")).toBe("racer");
  });
  it("refuses root alias redirection between proposal and apply", async () => {
    const f = await fixture(), alias = join(f.base, "alias"), other = join(f.base, "other"); await fs.symlink(f.root, alias, "junction"); await fs.mkdir(other);
    const p = await f.service.create(owner, producer, "run", { path: "new.txt", baseHash: null, content: "new" }, alias, f.guard);
    await fs.unlink(alias); await fs.symlink(other, alias, "junction"); const authorize = vi.fn(async () => true);
    const result = await f.service.apply(owner, p.id, { workspaceRoot: alias, guard: f.guard, authorize });
    expect(result.proposal.status).toBe("conflict"); expect(authorize).not.toHaveBeenCalled(); expect(await fs.readdir(other)).toEqual([]);
  });
  it("refuses a project directory replaced at the same physical spelling", async () => {
    const f = await fixture(), p = await f.create(null); await fs.rename(f.root, `${f.root}-old`); await fs.mkdir(f.root);
    const authorize = vi.fn(async () => true);
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize });
    expect(result.proposal.status).toBe("conflict"); expect(authorize).not.toHaveBeenCalled(); expect(await fs.readdir(f.root)).toEqual([]);
  });
  it("preserves metadata corrupted while authorization was pending and performs no write", async () => {
    const f = await fixture(), p = await f.create();
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => { await fs.writeFile(f.record(p.id), "{damaged during approval"); return true; } });
    expect(result.proposal.status).toBe("failed"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
    expect(await fs.readFile(f.record(p.id), "utf8")).toBe("{damaged during approval"); expect((await f.service.list(owner, f.guard)).damagedCount).toBe(1);
  });
  it("does not publish an owned temporary whose bytes were changed after writing", async () => {
    const f = await fixture(), p = await f.create(), original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await original(path, flags, mode);
      if (flags === "wx" && basename(String(path)).startsWith(".herta-plugin-")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); await fs.writeFile(path, "tampered stage"); });
      }
      return handle;
    });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("conflict"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it("refuses a parent replaced by a junction during approval", async () => {
    const f = await fixture(), p = await f.create("old", "new", "sub/file.txt"), outside = join(f.base, "outside"); await fs.mkdir(outside);
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => {
      await fs.rename(join(f.root, "sub"), join(f.root, "saved")); await fs.symlink(outside, join(f.root, "sub"), "junction"); return true;
    } });
    expect(result.proposal.status).toBe("failed"); expect(await fs.readdir(outside)).toEqual([]); expect(await fs.readFile(f.file("saved/file.txt"), "utf8")).toBe("old");
  });
  it("serializes the same proposal and refuses concurrent proposals for one path", async () => {
    const f = await fixture(), first = await f.create(), second = await f.service.create(owner, producer, "other-run", { path: "file.txt", baseHash: sha("old\n"), content: "other" }, f.root, f.guard);
    const entered = deferred<void>(), release = deferred<boolean>();
    const pending = f.service.apply(owner, first.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => { entered.resolve(); return release.promise; } }); await entered.promise;
    await expect(f.service.apply(owner, first.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true })).rejects.toMatchObject({ reason: "busy" });
    await expect(f.service.apply(owner, second.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true })).rejects.toMatchObject({ reason: "busy" });
    release.resolve(true); expect((await pending).proposal.status).toBe("applied"); expect((await f.service.read(owner, second.id, f.guard)).proposal.status).toBe("pending");
  });
  it("keeps the original intact when atomic rename fails", async () => {
    const f = await fixture(), p = await f.create(); vi.spyOn(nodefs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("fixture sharing error"), { code: "EBUSY" }); });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("failed"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n"); expect(await fs.readdir(f.root)).toEqual(["file.txt"]);
  });
  it("does not write if the applying intent cannot be persisted", async () => {
    const f = await fixture(), p = await f.create(), original = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { const record = JSON.parse(await fs.readFile(from, "utf8")); if (record.content?.proposal?.status === "applying") throw new Error("fixture full disk"); return original(from, to); });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("failed"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it("keeps the actual applied receipt if final metadata saving fails; restart requires review", async () => {
    const f = await fixture(), p = await f.create(), original = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { const record = JSON.parse(await fs.readFile(from, "utf8")); if (record.content?.proposal?.status === "applied") throw new Error("fixture full disk"); return original(from, to); });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("applied"); expect(result.proposal.message).toContain("文件已写入"); expect(await fs.readFile(f.file(), "utf8")).toBe("new\n");
    expect((await f.service.read(owner, p.id, f.guard)).proposal.status).toBe("applied");
    expect((await f.service.markNeedsReview(owner, p.id, f.guard)).proposal.status).toBe("applied");
    const restarted = new PluginPatchService({ profile: f.profile, protectedPaths: [] });
    expect((await restarted.read(owner, p.id, f.guard)).proposal.status).toBe("needs-review");
    const authorize = vi.fn(async () => true); await expect(restarted.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize })).rejects.toMatchObject({ reason: "conflict" }); expect(authorize).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(f.record(p.id), "utf8")).content.proposal.status).toBe("applying");
  });
  it("preserves successful write facts if the owner is revoked at the commit boundary", async () => {
    const f = await fixture(), p = await f.create(), rename = nodefs.renameSync;
    vi.spyOn(nodefs, "renameSync").mockImplementation((from, to) => { rename(from, to); f.revoke(); });
    const result = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    expect(result.proposal.status).toBe("applied"); expect(await fs.readFile(f.file(), "utf8")).toBe("new\n");
    const independent = { signal: new AbortController().signal, assertCurrent() {} };
    expect((await new PluginPatchService({ profile: f.profile, protectedPaths: [] }).read(owner, p.id, independent)).proposal.status).toBe("applied");
  });
});

describe("uncertain host application recovery", () => {
  it.each(["pending", "denied", "cancelled", "failed", "conflict"])("persists needs-review from valid %s and refuses automatic application after restart", async status => {
    const f = await fixture(), p = await f.create(), file = f.record(p.id), raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.content.proposal.status = status; await fs.writeFile(file, JSON.stringify(raw));
    const marked = await f.service.markNeedsReview(owner, p.id, f.guard);
    expect(marked.proposal.status).toBe("needs-review"); expect(marked.proposal.message).toContain("最终状态未能确认");
    expect(await fs.readFile(f.file(), "utf8")).toBe("old\n"); expect(marked.before).toBe("old\n"); expect(marked.after).toBe("new\n");
    const restarted = new PluginPatchService({ profile: f.profile, protectedPaths: [] });
    expect(await restarted.read(owner, p.id, f.guard)).toEqual(marked);
    const authorize = vi.fn(async () => true);
    await expect(restarted.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize })).rejects.toMatchObject({ reason: "conflict" });
    expect(authorize).not.toHaveBeenCalled();
    const frozen = await fs.readFile(file, "utf8"); expect(await restarted.markNeedsReview(owner, p.id, f.guard)).toEqual(marked); expect(await fs.readFile(file, "utf8")).toBe(frozen);
  });
  it("never downgrades an authoritative applied record or rewrites its file", async () => {
    const f = await fixture(), p = await f.create();
    const applied = await f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    const saved = await fs.readFile(f.record(p.id), "utf8"), restarted = new PluginPatchService({ profile: f.profile, protectedPaths: [] });
    expect(await restarted.markNeedsReview(owner, p.id, f.guard)).toEqual(applied);
    expect(await fs.readFile(f.record(p.id), "utf8")).toBe(saved); expect(await fs.readFile(f.file(), "utf8")).toBe("new\n");
  });
  it("does not replace corrupted records using a previously read snapshot", async () => {
    const f = await fixture(), p = await f.create(); await f.service.read(owner, p.id, f.guard);
    await fs.writeFile(f.record(p.id), "{preserve damaged original");
    await expect(f.service.markNeedsReview(owner, p.id, f.guard)).rejects.toMatchObject({ reason: "damaged" });
    expect(await fs.readFile(f.record(p.id), "utf8")).toBe("{preserve damaged original"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it("throws on needs-review persistence failure while preserving the authoritative record", async () => {
    const f = await fixture(), p = await f.create(), original = await fs.readFile(f.record(p.id), "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic failure"));
    await expect(f.service.markNeedsReview(owner, p.id, f.guard)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await fs.readFile(f.record(p.id), "utf8")).toBe(original); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
    expect((await f.service.read(owner, p.id, f.guard)).proposal.status).toBe("pending");
  });
  it("does not relabel a live host apply while authorization is pending", async () => {
    const f = await fixture(), p = await f.create(), entered = deferred<void>(), release = deferred<boolean>();
    const applying = f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => { entered.resolve(); return release.promise; } });
    await entered.promise;
    try { await expect(f.service.markNeedsReview(owner, p.id, f.guard)).rejects.toMatchObject({ reason: "busy" }); }
    finally { release.resolve(false); await applying; }
    expect((await applying).proposal.status).toBe("denied"); expect(await fs.readFile(f.file(), "utf8")).toBe("old\n");
  });
  it("reads a live persisted intent as applying until its actual writer settles", async () => {
    const f = await fixture(), p = await f.create(), entered = deferred<void>(), release = deferred<void>(), original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (flags === "wx" && basename(String(path)).startsWith(".herta-plugin-")) { entered.resolve(); await release.promise; }
      return original(path, flags, mode);
    });
    const applying = f.service.apply(owner, p.id, { workspaceRoot: f.root, guard: f.guard, authorize: async () => true });
    await entered.promise;
    try {
      expect((await f.service.read(owner, p.id, f.guard)).proposal.status).toBe("applying");
      expect(JSON.parse(await fs.readFile(f.record(p.id), "utf8")).content.proposal.status).toBe("applying");
    } finally { release.resolve(); await applying; }
    expect((await applying).proposal.status).toBe("applied");
  });
});
