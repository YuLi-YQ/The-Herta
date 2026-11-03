import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginOutputOwner, PluginOutputProducer } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault } from "./capability-broker.js";
import { PluginArtifactStore, type PluginArtifactGuard } from "./plugin-artifact-store.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

const roots: string[] = [];
const owner: PluginOutputOwner = { scope: "chat", target: "synthetic-chat" };
const producer: PluginOutputProducer = { id: "example.writer", name: "合成写作器", version: "1.0.0", contentHash: "a".repeat(64), grantRevision: 1 };
const input = { name: "report.md", mime: "text/markdown", text: "合成资料" };
function guard() {
  const controller = new AbortController(); let live = true;
  const context: PluginArtifactGuard = { signal: controller.signal, assertCurrent() { if (!live) throw new PluginBrokerFault("revoked"); } };
  return { context, controller, revoke() { live = false; } };
}
async function fixture(limits?: ConstructorParameters<typeof PluginArtifactStore>[1]) {
  const root = await fs.mkdtemp(join(tmpdir(), "herta-artifact-store-")); roots.push(root);
  const profile = join(root, "profile"); await fs.mkdir(profile);
  const store = new PluginArtifactStore(profile, limits), g = guard(); return { root, profile, store, ...g };
}
const folder = (profile: string, selected = owner) => join(profile, "plugin-artifacts-v1", createHash("sha256").update(JSON.stringify(selected)).digest("hex"));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (!isPathInside(resolve(tmpdir()), absolute, { strict: true }) || !basename(absolute).startsWith("herta-artifact-store-") || (await fs.lstat(absolute)).isSymbolicLink()) throw Error("Unsafe fixture cleanup");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe("persistent plugin text artifacts", () => {
  it("R142 budget counts other namespaces and refuses before creating an artifact temporary", async () => {
    const f = await fixture(), storage = new PluginStorageCoordinator(f.profile, { limitBytes: 4096 });
    await fs.mkdir(join(f.profile, "plugins-v2"));
    const unrelated = join(f.profile, "plugins-v2", "damaged-orphan.json");
    await fs.writeFile(unrelated, Buffer.alloc(4095, 65));
    const store = new PluginArtifactStore(f.profile, { storage }), open = vi.spyOn(fs, "open");
    await expect(store.create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "limit", code: "resource-limit" });
    expect(open).not.toHaveBeenCalled(); expect(await fs.readdir(folder(f.profile))).toEqual([]);
    expect((await storage.snapshot(f.context)).usedBytes).toBe(4095);
    expect((await fs.stat(unrelated)).size).toBe(4095);
  });
  it("R142 budget reserves both publication paths and preserves a committed artifact after cancellation", async () => {
    const f = await fixture(), first = await f.store.create(owner, producer, "run", input, f.context);
    const bytes = (await fs.stat(join(folder(f.profile), `${first.id}.json`))).size;
    const storage = new PluginStorageCoordinator(f.profile, { limitBytes: 3 * bytes });
    const write = vi.spyOn(storage, "withWrite"), store = new PluginArtifactStore(f.profile, { storage });
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (source, destination) => { await link(source, destination); f.controller.abort(); });
    const saved = await store.create(owner, producer, "run", input, f.context);
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]![0]).toBe(2 * bytes);
    const current = guard().context;
    expect((await storage.snapshot(current)).usedBytes).toBe(2 * bytes);
    expect((await store.read(owner, saved.id, current)).content).toBe(input.text);
    expect((await fs.readdir(folder(f.profile))).sort()).toEqual([`${first.id}.json`, `${saved.id}.json`].sort());
  });
  it("preserves exact UTF8, metadata and ownership after restart without messages or paths", async () => {
    const f = await fixture(), text = "\uFEFF黑塔 🌌\r\n最后一行\n";
    const saved = await f.store.create(owner, producer, "synthetic-run", { ...input, text }, f.context);
    expect(saved.bytes).toBe(Buffer.byteLength(text)); expect(saved.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    const restarted = new PluginArtifactStore(f.profile);
    expect(await restarted.read(owner, saved.id, f.context)).toEqual({ artifact: saved, content: text });
    expect((await restarted.list(owner, f.context)).items).toEqual([saved]);
    expect(JSON.stringify(saved)).not.toContain(f.profile); expect(Object.isFrozen(saved.producer)).toBe(true);
    expect(await fs.readdir(f.profile)).toEqual(["plugin-artifacts-v1"]);
  });
  it("does not create storage for a missing list and does not read another owner", async () => {
    const f = await fixture(); expect(await f.store.list(owner, f.context)).toEqual({ items: [], damagedCount: 0 });
    expect(await fs.readdir(f.profile)).toEqual([]);
    const saved = await f.store.create(owner, producer, "run", input, f.context), opening = vi.spyOn(fs, "open");
    for (const other of [{ scope: "workbench", target: owner.target }, { scope: "chat", target: "another" }] as const) {
      expect(await f.store.list(other, f.context)).toEqual({ items: [], damagedCount: 0 });
      await expect(f.store.read(other, saved.id, f.context)).rejects.toMatchObject({ reason: "not-found" });
    }
    expect(opening).not.toHaveBeenCalled();
  });
  it("keeps repeated names immutable and supports all four text formats including empty files", async () => {
    const f = await fixture(), ids = new Set<string>();
    for (const mime of ["text/plain", "text/markdown", "text/csv", "application/json"]) {
      const saved = await f.store.create(owner, producer, "run", { name: "same.txt", mime, text: "" }, f.context);
      ids.add(saved.id); expect((await f.store.read(owner, saved.id, f.context)).content).toBe("");
    }
    expect(ids.size).toBe(4); expect((await f.store.list(owner, f.context)).items).toHaveLength(4);
  });
  it.each([
    { name: "../escape.txt" }, { name: "CON.txt" }, { name: "bad:stream" }, { name: "tail." }, { name: "bad\nname.txt" },
    { mime: "text/html" }, { text: "nul\u0000" }, { text: "\ud800" }, { text: "\udc00" }, { text: "x".repeat(48001) },
  ])("rejects invalid inputs without writing (%#)", async change => {
    const f = await fixture();
    await expect(f.store.create(owner, producer, "run", { ...input, ...change }, f.context)).rejects.toMatchObject({ reason: "invalid" });
    expect(await fs.readdir(f.profile)).toEqual([]);
  });
  it("refuses UTF8 byte overflow separately from the UTF16 text limit", async () => {
    const f = await fixture();
    await expect(f.store.create(owner, producer, "run", { ...input, text: "中".repeat(47000) }, f.context)).rejects.toMatchObject({ reason: "limit" });
  });
  it("lists valid outputs beside damaged entries without erasing evidence", async () => {
    const f = await fixture(), a = await f.store.create(owner, producer, "run", input, f.context);
    const b = await f.store.create(owner, producer, "run", input, f.context), broken = join(folder(f.profile), b.id + ".json");
    await fs.writeFile(broken, "{broken"); await fs.writeFile(join(folder(f.profile), ".abandoned.tmp"), "partial");
    expect(await f.store.list(owner, f.context)).toEqual({ items: [a], damagedCount: 2 });
    expect(await fs.readFile(broken, "utf8")).toBe("{broken");
    await expect(f.store.read(owner, b.id, f.context)).rejects.toMatchObject({ reason: "damaged" });
  });
  it("rejects modified content hashes and transplanted owner envelopes", async () => {
    const f = await fixture(), saved = await f.store.create(owner, producer, "run", input, f.context), file = join(folder(f.profile), saved.id + ".json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")); raw.content = "tampered";
    await fs.writeFile(file, JSON.stringify(raw)); await expect(f.store.read(owner, saved.id, f.context)).rejects.toMatchObject({ reason: "damaged" });
    raw.content = input.text; raw.owner.target = "another"; await fs.writeFile(file, JSON.stringify(raw));
    expect((await f.store.list(owner, f.context)).damagedCount).toBe(1);
  });
  it("counts corrupt records against session count and global byte quotas", async () => {
    const f = await fixture({ sessionRecords: 2 }), saved = await f.store.create(owner, producer, "run", input, f.context);
    await fs.writeFile(join(folder(f.profile), "damaged.file"), "bad");
    await expect(f.store.create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "limit" });
    expect((await f.store.read(owner, saved.id, f.context)).content).toBe(input.text);
    const small = new PluginArtifactStore(f.profile, { totalBytes: 2000 });
    const unknown = join(f.profile, "plugin-artifacts-v1", "quota-corrupt"); await fs.writeFile(unknown, Buffer.alloc(2001));
    await expect(small.create({ scope: "chat", target: "another" }, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "limit" });
    expect((await fs.stat(unknown)).size).toBe(2001);
  });
  it("serializes concurrent creates so only the allowed number commits", async () => {
    const f = await fixture({ sessionRecords: 2 });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => f.store.create(owner, producer, "run", input, f.context)));
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(2);
    expect((await f.store.list(owner, f.context)).items).toHaveLength(2); expect((await f.store.list(owner, f.context)).damagedCount).toBe(0);
  });
  it("does not allow the host test policy to increase production limits", async () => {
    const f = await fixture(); expect(() => new PluginArtifactStore(f.profile, { sessionRecords: 101 })).toThrow();
  });
  it("snapshots owner, producer and text before waiting in the host queue", async () => {
    const f = await fixture(), selected = { ...owner }, source = { ...producer }, args = { ...input };
    const saving = f.store.create(selected, source, "run", args, f.context);
    selected.target = "changed"; source.name = "changed"; args.text = "changed";
    const saved = await saving;
    expect(saved.producer.name).toBe(producer.name); expect((await f.store.read(owner, saved.id, f.context)).content).toBe(input.text);
    expect((await f.store.list(selected, f.context)).items).toHaveLength(0);
  });
  it("enforces total record count across owners and per-owner file byte budgets", async () => {
    const f = await fixture({ totalRecords: 2 });
    const a = await f.store.create(owner, producer, "run", input, f.context);
    await f.store.create({ ...owner, target: "second" }, producer, "run", input, f.context);
    await expect(f.store.create({ ...owner, target: "third" }, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "limit" });
    const bytes = (await fs.stat(join(folder(f.profile), a.id + ".json"))).size;
    await expect(new PluginArtifactStore(f.profile, { sessionBytes: bytes + 1 }).create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "limit" });
  });
  it("rejects a replaced physical profile rather than treating it as a fresh empty library", async () => {
    const f = await fixture(); await f.store.create(owner, producer, "run", input, f.context);
    await fs.rename(f.profile, f.profile + "-original"); await fs.mkdir(f.profile);
    await expect(f.store.list(owner, f.context)).rejects.toMatchObject({ reason: "damaged" });
    expect(await fs.readdir(f.profile)).toEqual([]);
  });
  it("cancels before publication and cleans only its own temporary", async () => {
    const f = await fixture(), original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode);
      if (flags === "wx") { const sync = handle.sync.bind(handle); vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); f.revoke(); }); }
      return handle;
    });
    await expect(f.store.create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ code: "revoked" });
    expect(await fs.readdir(folder(f.profile))).toEqual([]);
  });
  it("reports a committed output even when cancellation arrives during the publication syscall", async () => {
    const f = await fixture(), original = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => { await original(from, to); f.controller.abort(); });
    const saved = await f.store.create(owner, producer, "run", input, f.context);
    expect((await new PluginArtifactStore(f.profile).read(owner, saved.id, guard().context)).content).toBe(input.text);
  });
  it("does not report a committed output as failed when first temporary cleanup fails", async () => {
    const f = await fixture(); vi.spyOn(fs, "unlink").mockImplementationOnce(async () => { f.controller.abort(); throw Object.assign(Error("temporary busy"), { code: "EBUSY" }); });
    const saved = await f.store.create(owner, producer, "run", input, f.context);
    expect((await f.store.read(owner, saved.id, guard().context)).content).toBe(input.text);
    expect(await fs.readdir(folder(f.profile))).toEqual([saved.id + ".json"]);
  });
  it("leaves a wx collision untouched rather than deleting another writer's temporary", async () => {
    const f = await fixture(), original = fs.open.bind(fs); let collision = "";
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (flags === "wx") { collision = String(file); await fs.writeFile(collision, "other writer"); throw Object.assign(Error("collision"), { code: "EEXIST" }); }
      return original(file, flags, mode);
    });
    await expect(f.store.create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await fs.readFile(collision, "utf8")).toBe("other writer");
  });
  it("does not overwrite a destination that appears before no-clobber publication", async () => {
    const f = await fixture(), original = fs.link.bind(fs); let collision = "";
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => { collision = String(to); await fs.writeFile(to, "external"); return original(from, to); });
    await expect(f.store.create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await fs.readFile(collision, "utf8")).toBe("external"); expect(await fs.readdir(folder(f.profile))).toHaveLength(1);
  });
  it("rejects hardlinked data and directory junctions without touching outside data", async () => {
    const f = await fixture(), saved = await f.store.create(owner, producer, "run", input, f.context), file = join(folder(f.profile), saved.id + ".json");
    await fs.link(file, join(f.root, "external-link"));
    await expect(f.store.read(owner, saved.id, f.context)).rejects.toMatchObject({ reason: "damaged" });
    await expect(f.store.create(owner, producer, "run", input, f.context)).rejects.toMatchObject({ reason: "damaged" });
    const outside = join(f.root, "outside"); await fs.mkdir(outside); await fs.writeFile(join(outside, "untouched"), "outside");
    const different = { scope: "chat", target: "linked-owner" } as const; await fs.symlink(outside, folder(f.profile, different), "junction");
    await expect(f.store.list(different, f.context)).rejects.toMatchObject({ reason: "damaged" });
    expect(await fs.readdir(outside)).toEqual(["untouched"]);
  });
  it("rejects a linked profile and closes a read handle cancelled during open", async () => {
    const f = await fixture(), alias = join(f.root, "alias"); await fs.symlink(f.profile, alias, "junction");
    await expect(new PluginArtifactStore(alias).list(owner, f.context)).rejects.toMatchObject({ reason: "damaged" });
    const saved = await f.store.create(owner, producer, "run", input, f.context), original = fs.open.bind(fs); let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => { opened = await original(file, flags, mode); f.controller.abort(); return opened; });
    await expect(f.store.read(owner, saved.id, f.context)).rejects.toMatchObject({ code: "cancelled" }); expect(opened?.fd).toBe(-1);
  });
});
