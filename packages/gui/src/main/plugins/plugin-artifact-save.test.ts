import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginOutputOwner } from "../../shared/plugin-deliverables.js";
import { PluginBrokerFault } from "./capability-broker.js";
import { PluginArtifactStore, type PluginArtifactGuard } from "./plugin-artifact-store.js";
import { createPluginArtifactSaver } from "./plugin-artifact-save.js";

const roots: string[] = [];
const owner: PluginOutputOwner = { scope: "workbench", target: "synthetic-task" };
const exact = "\uFEFF黑塔 🌌\r\noriginal bytes\n";
function guard() {
  const controller = new AbortController(); let live = true;
  const context: PluginArtifactGuard = { signal: controller.signal, assertCurrent() { if (!live) throw new PluginBrokerFault("revoked"); } };
  return { context, controller, revoke() { live = false; } };
}
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "herta-artifact-save-")); roots.push(root);
  const profile = join(root, "profile"), output = join(root, "output"), protectedDir = join(root, "protected");
  for (const dir of [profile, output, protectedDir]) await fs.mkdir(dir);
  const store = new PluginArtifactStore(profile), g = guard();
  const artifact = await store.create(owner, { id: "example.writer", name: "合成写作器", version: "1.0.0", contentHash: "a".repeat(64), grantRevision: 1 }, "run", { name: "original.md", mime: "text/markdown", text: exact }, g.context);
  const destination = join(output, "selected.md"), choose = vi.fn(async (_name: string) => ({ canceled: false, filePath: destination }));
  const save = createPluginArtifactSaver({ store, profile, protectedPaths: [protectedDir], choose });
  return { root, profile, output, protectedDir, store, artifact, destination, choose, save, ...g };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (!isPathInside(resolve(tmpdir()), absolute, { strict: true }) || !basename(absolute).startsWith("herta-artifact-save-") || (await fs.lstat(absolute)).isSymbolicLink()) throw Error("Unsafe fixture cleanup");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe("explicit artifact save", () => {
  it("loads authoritative content by owner/id and saves exact bytes to the selected path", async () => {
    const f = await fixture();
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: true });
    expect(f.choose).toHaveBeenCalledWith("original.md");
    expect(await fs.readFile(f.destination)).toEqual(Buffer.from(exact, "utf8"));
    expect(await fs.readdir(f.output)).toEqual(["selected.md"]);
  });
  it("atomically replaces an unchanged existing target", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "old");
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe(exact);
  });
  it("does not open the picker for another owner's or a corrupted artifact", async () => {
    const f = await fixture();
    expect(await f.save({ scope: "chat", target: owner.target }, f.artifact.id, f.context)).toEqual({ saved: false, failed: true });
    expect(f.choose).not.toHaveBeenCalled();
  });
  it("does not create a destination on dialog cancellation", async () => {
    const f = await fixture(); f.choose.mockResolvedValueOnce({ canceled: true, filePath: f.destination });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false }); expect(await fs.readdir(f.output)).toEqual([]);
  });
  it("rechecks owner after the asynchronous dialog and preserves an existing target", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "keep");
    f.choose.mockImplementationOnce(async () => { f.revoke(); return { canceled: false, filePath: f.destination }; });
    await expect(f.save(owner, f.artifact.id, f.context)).rejects.toMatchObject({ code: "revoked" });
    expect(await fs.readFile(f.destination, "utf8")).toBe("keep"); expect(await fs.readdir(f.output)).toEqual(["selected.md"]);
  });
  it("checks cancellation before opening the picker", async () => {
    const f = await fixture(); f.controller.abort();
    await expect(f.save(owner, f.artifact.id, f.context)).rejects.toMatchObject({ code: "cancelled" }); expect(f.choose).not.toHaveBeenCalled();
  });
  it("retains old bytes when temporary writing fails partway", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "old exact"); const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode);
      if (flags === "wx") vi.spyOn(handle, "writeFile").mockImplementation(async () => { await handle.write("partial"); throw Object.assign(Error("synthetic disk full"), { code: "ENOSPC" }); });
      return handle;
    });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, failed: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe("old exact"); expect(await fs.readdir(f.output)).toEqual(["selected.md"]);
  });
  it("retains old bytes when atomic replacement fails", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "old exact"); vi.spyOn(fs, "rename").mockRejectedValueOnce(Error("synthetic rename failure"));
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, failed: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe("old exact"); expect(await fs.readdir(f.output)).toEqual(["selected.md"]);
  });
  it("cancels a staged save without publishing or changing the target", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "old"); const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode);
      if (flags === "wx") { const sync = handle.sync.bind(handle); vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); f.controller.abort(); }); }
      return handle;
    });
    await expect(f.save(owner, f.artifact.id, f.context)).rejects.toMatchObject({ code: "cancelled" });
    expect(await fs.readFile(f.destination, "utf8")).toBe("old"); expect(await fs.readdir(f.output)).toEqual(["selected.md"]);
  });
  it("reports saved after cancellation during a completed replacement syscall", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "old"); const original = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { await original(from, to); f.controller.abort(); });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: true }); expect(await fs.readFile(f.destination, "utf8")).toBe(exact);
  });
  it("reports a committed new save truthfully and retries temporary cleanup", async () => {
    const f = await fixture(); vi.spyOn(fs, "unlink").mockImplementationOnce(async () => { f.controller.abort(); throw Object.assign(Error("temporary busy"), { code: "EBUSY" }); });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe(exact); expect(await fs.readdir(f.output)).toEqual(["selected.md"]);
  });
  it("refuses a target changed while the new bytes are staged", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "old"); const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await original(file, flags, mode);
      if (flags === "wx") { const sync = handle.sync.bind(handle); vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); await fs.writeFile(f.destination, "external change"); }); }
      return handle;
    });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, conflict: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe("external change");
  });
  it("does not clobber a new target created immediately before publication", async () => {
    const f = await fixture(), original = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => { await fs.writeFile(to, "arrived later"); return original(from, to); });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, conflict: true });
    expect(await fs.readFile(f.destination, "utf8")).toBe("arrived later");
  });
  it("preserves another writer's wx-collision temporary", async () => {
    const f = await fixture(), original = fs.open.bind(fs); let collision = "";
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (flags === "wx") { collision = String(file); await fs.writeFile(collision, "other temp"); throw Object.assign(Error("collision"), { code: "EEXIST" }); }
      return original(file, flags, mode);
    });
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, failed: true }); expect(await fs.readFile(collision, "utf8")).toBe("other temp");
  });
  it("refuses profile, protected destinations and junction aliases into them", async () => {
    const f = await fixture(), alias = join(f.root, "protected-alias"); await fs.symlink(f.protectedDir, alias, "junction");
    for (const dir of [f.profile, f.protectedDir, alias]) {
      f.choose.mockResolvedValueOnce({ canceled: false, filePath: join(dir, "forbidden.txt") });
      expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, failed: true });
      await expect(fs.stat(join(dir, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("refuses a hardlinked destination and preserves both names", async () => {
    const f = await fixture(); await fs.writeFile(f.destination, "keep"); const other = join(f.output, "other.txt"); await fs.link(f.destination, other);
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, conflict: true });
    expect(await fs.readFile(other, "utf8")).toBe("keep"); expect(await fs.readFile(f.destination, "utf8")).toBe("keep");
  });
  it("bounds existing-target reads and keeps a large selected file unchanged", async () => {
    const f = await fixture(), handle = await fs.open(f.destination, "w"); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
    expect(await f.save(owner, f.artifact.id, f.context)).toEqual({ saved: false, conflict: true });
    expect((await fs.stat(f.destination)).size).toBe(16 * 1024 * 1024 + 1);
  });
});
