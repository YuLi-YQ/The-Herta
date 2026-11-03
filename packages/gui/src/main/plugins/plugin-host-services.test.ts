import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginBrokerFault, type PluginCapabilityContext } from "./capability-broker.js";
import { PrivatePluginStorage, PluginStorageFault, readPluginWorkspaceText } from "./plugin-host-services.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";

const folders: string[]=[];
async function folder() { const dir=await fs.mkdtemp(join(tmpdir(),"herta-plugin-host-"));folders.push(dir);return dir; }
function context(pluginId="example.plugin") {
  const controller=new AbortController(); let live=true;
  const ctx:PluginCapabilityContext={binding:{pluginId,contentHash:"a".repeat(64),grantRevision:1,sessionId:"synthetic",sessionRevision:1,permissionRevision:1,scope:"workbench",actionId:"run"},signal:controller.signal,
    assertCurrent(){if(controller.signal.aborted)throw new PluginBrokerFault("cancelled");if(!live)throw new PluginBrokerFault("revoked");}};
  return {ctx,controller,revoke:()=>{live=false;}};
}
function storagePath(profile:string,id="example.plugin") { return join(profile,"plugin-data-v2",createHash("sha256").update(id).digest("hex")+".json"); }

describe("R143 private backup and explicit recovery", () => {
  const hostGuard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
  it("reserves every archive hard-link temp name before restoring a large current record from a small backup", async () => {
    const profile = await folder(), c = context(), guard = hostGuard(), original = new PrivatePluginStorage(profile), file = storagePath(profile);
    await original.set("example.plugin", "key", "small-backup", c.ctx);
    await original.set("example.plugin", "key", "x".repeat(30000), c.ctx);
    const before = await fs.readFile(file), backupBefore = await fs.readFile(file + ".backup");
    const used = (await new PluginStorageCoordinator(profile).snapshot(guard)).usedBytes;
    // One archive copy plus the small restored record/receipt would fit here;
    // retaining every temporary hard-link name during publication would not.
    const limited = new PrivatePluginStorage(profile, new PluginStorageCoordinator(profile, { limitBytes: used + before.length + 1024 }));
    const preview = await limited.previewRecovery("example.plugin", "restore", 1, guard);
    expect(preview).toMatchObject({ canConfirm: true, current: { state: "valid" }, backup: { state: "valid" } });
    const linking = vi.spyOn(fs, "link"), opening = vi.spyOn(fs, "open");
    await expect(limited.confirmRecovery(preview.id, 1, guard)).rejects.toMatchObject({ reason: "limit" });
    expect(linking).not.toHaveBeenCalled(); expect(opening).not.toHaveBeenCalled();
    expect(await fs.readFile(file)).toEqual(before); expect(await fs.readFile(file + ".backup")).toEqual(backupBefore);
    expect(await fs.readdir(join(profile, "plugin-data-v2"))).toHaveLength(2);
  });
  it("backs up first and previous valid values and restores damaged bytes through metadata-only preview", async () => {
    const profile = await folder(), store = new PrivatePluginStorage(profile), c = context(), guard = hostGuard(), file = storagePath(profile);
    expect((await store.previewRecovery("example.plugin", "restore", 7, guard)).canConfirm).toBe(false);
    expect(await fs.readdir(profile)).toEqual([]);
    await store.set("example.plugin", "key", "synthetic-first-value", c.ctx);
    expect(JSON.parse(await fs.readFile(file + ".backup", "utf8")).values.key).toBe("synthetic-first-value");
    await store.set("example.plugin", "key", "synthetic-next-value", c.ctx);
    expect(JSON.parse(await fs.readFile(file + ".backup", "utf8")).values.key).toBe("synthetic-first-value");
    const bad = Buffer.from([0xff, 0x00, 0x41]); await fs.writeFile(file, bad);
    const preview = await store.previewRecovery("example.plugin", "restore", 7, guard);
    expect(preview).toMatchObject({ canConfirm: true, current: { state: "damaged", bytes: 3 }, backup: { state: "valid", keys: 1, savedAt: expect.any(String) } });
    expect(JSON.stringify(preview)).not.toContain("synthetic-first-value"); expect(JSON.stringify(preview)).not.toContain(profile);
    expect(await store.confirmRecovery(preview.id, 7, guard)).toMatchObject({ action: "restore", keys: 1, archived: true });
    expect(await store.get("example.plugin", "key", c.ctx)).toBe('"synthetic-first-value"');
    const archived = (await fs.readdir(join(profile, "plugin-data-v2"))).find(name => name.includes(".archive-"))!;
    expect(await fs.readFile(join(profile, "plugin-data-v2", archived, "current.bin"))).toEqual(bad);
  });
  it("keeps first current missing when its publication fails after backup and allows explicit backup recovery", async () => {
    const profile = await folder(), store = new PrivatePluginStorage(profile), c = context(), guard = hostGuard(), file = storagePath(profile);
    const rename = fs.rename.bind(fs); let failed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === file && !failed) { failed = true; throw Object.assign(new Error("synthetic publication failure"), { code: "EACCES" }); }
      return rename(from, to);
    });
    await expect(store.set("example.plugin", "key", "initial", c.ctx)).rejects.toMatchObject({ reason: "unavailable" });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" }); expect(await store.get("example.plugin", "key", c.ctx)).toBe("null");
    const preview = await store.previewRecovery("example.plugin", "restore", 1, guard);
    expect(preview).toMatchObject({ current: { state: "missing" }, backup: { state: "valid" }, canConfirm: true });
    expect(await store.confirmRecovery(preview.id, 1, guard)).toMatchObject({ archived: false });
    expect(await store.get("example.plugin", "key", c.ctx)).toBe('"initial"');
  });
  it("invalidates confirmation after Guest writes, backup changes, host revision changes or token reuse", async () => {
    const profile = await folder(), store = new PrivatePluginStorage(profile), c = context(), guard = hostGuard(), file = storagePath(profile);
    await store.set("example.plugin", "key", "first", c.ctx);
    const staleCurrent = await store.previewRecovery("example.plugin", "restore", 1, guard);
    await store.set("example.plugin", "key", "second", c.ctx);
    await expect(store.confirmRecovery(staleCurrent.id, 1, guard)).rejects.toMatchObject({ reason: "changed" });
    const staleBackup = await store.previewRecovery("example.plugin", "restore", 1, guard);
    const backup = JSON.parse(await fs.readFile(file + ".backup", "utf8")); backup.values.key = "external-change";
    await fs.writeFile(file + ".backup", JSON.stringify(backup));
    await expect(store.confirmRecovery(staleBackup.id, 1, guard)).rejects.toMatchObject({ reason: "changed" });
    const staleHost = await store.previewRecovery("example.plugin", "restore", 1, guard);
    await expect(store.confirmRecovery(staleHost.id, 2, guard)).rejects.toMatchObject({ reason: "changed" });
    const usable = await store.previewRecovery("example.plugin", "restore", 2, guard);
    const attempts = await Promise.allSettled([store.confirmRecovery(usable.id, 2, guard), store.confirmRecovery(usable.id, 2, guard)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(store.confirmRecovery(usable.id, 2, guard)).rejects.toMatchObject({ reason: "changed" });
  });
  it("requires explicit reset without a valid backup and preserves both originals when archiving fails", async () => {
    const profile = await folder(), store = new PrivatePluginStorage(profile), c = context(), guard = hostGuard(), file = storagePath(profile);
    await store.set("example.plugin", "key", "valid-before-damage", c.ctx);
    await fs.writeFile(file, "{broken-current"); await fs.writeFile(file + ".backup", "{broken-backup");
    await expect(store.set("example.plugin", "key", "new", c.ctx)).rejects.toMatchObject({ reason: "damaged" });
    const unavailable = await store.previewRecovery("example.plugin", "restore", 1, guard);
    expect(unavailable.canConfirm).toBe(false); await expect(store.confirmRecovery(unavailable.id, 1, guard)).rejects.toMatchObject({ reason: "no-backup" });
    const preview = await store.previewRecovery("example.plugin", "reset", 1, guard);
    const linking = vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("synthetic archive failure"), { code: "EACCES" }));
    await expect(store.confirmRecovery(preview.id, 1, guard)).rejects.toMatchObject({ reason: "unavailable" }); linking.mockRestore();
    expect(await fs.readFile(file, "utf8")).toBe("{broken-current"); expect(await fs.readFile(file + ".backup", "utf8")).toBe("{broken-backup");
    const retry = await store.previewRecovery("example.plugin", "reset", 1, guard);
    expect(await store.confirmRecovery(retry.id, 1, guard)).toMatchObject({ action: "reset", keys: 0, archived: true });
    expect(await store.get("example.plugin", "key", c.ctx)).toBe("null");
    expect(JSON.parse(await fs.readFile(file + ".backup", "utf8")).values).toEqual({});
    const names = await fs.readdir(join(profile, "plugin-data-v2"));
    const preserved = await Promise.all(names.filter(name => name.includes(".archive-")).map(async name => fs.readFile(join(profile, "plugin-data-v2", name, "backup.bin"), "utf8").catch(() => "")));
    expect(preserved).toContain("{broken-backup");
  });
  it("reserves backup/archive peaks and leaves originals unchanged on quota refusal or cancelled confirmation", async () => {
    const profile = await folder(), c = context(), guard = hostGuard(), original = new PrivatePluginStorage(profile), file = storagePath(profile);
    await original.set("example.plugin", "key", "saved", c.ctx); await fs.writeFile(file, "{damaged");
    const used = (await new PluginStorageCoordinator(profile).snapshot(guard)).usedBytes;
    const limited = new PrivatePluginStorage(profile, new PluginStorageCoordinator(profile, { limitBytes: used }));
    const preview = await limited.previewRecovery("example.plugin", "restore", 1, guard);
    await expect(limited.confirmRecovery(preview.id, 1, guard)).rejects.toMatchObject({ reason: "limit" });
    expect(await fs.readFile(file, "utf8")).toBe("{damaged"); expect(await fs.readdir(join(profile, "plugin-data-v2"))).toHaveLength(2);
    const next = await original.previewRecovery("example.plugin", "restore", 1, guard), abort = new AbortController(); abort.abort();
    await expect(original.confirmRecovery(next.id, 1, { signal: abort.signal, assertCurrent() {} })).rejects.toMatchObject({ reason: "cancelled" });
    expect(await fs.readFile(file, "utf8")).toBe("{damaged");
  });
});

describe("R142 shared storage budget for private records", () => {
  it("keeps old private values when another namespace exhausts the shared budget", async () => {
    const profile = await folder(), c = context(), original = new PrivatePluginStorage(profile);
    await original.set("example.plugin", "key", "before", c.ctx);
    const file = storagePath(profile), before = await fs.readFile(file, "utf8");
    const artifacts = join(profile, "plugin-artifacts-v1"); await fs.mkdir(artifacts); await fs.writeFile(join(artifacts, "orphan.bin"), Buffer.alloc(512));
    const store = new PrivatePluginStorage(profile, new PluginStorageCoordinator(profile, { limitBytes: 512 }));
    await expect(store.set("example.plugin", "key", "after", c.ctx)).rejects.toMatchObject({ code: "resource-limit", reason: "limit" });
    expect(await fs.readFile(file, "utf8")).toBe(before); expect(await store.get("example.plugin", "key", c.ctx)).toBe('"before"');
    expect(await fs.readdir(join(profile, "plugin-data-v2"))).toHaveLength(2);
  });
  it("reserves temporary replacement peak instead of deducting the existing private record", async () => {
    const profile = await folder(), c = context(), original = new PrivatePluginStorage(profile);
    await original.set("example.plugin", "key", "before", c.ctx);
    const file = storagePath(profile), before = await fs.readFile(file, "utf8"), next = JSON.parse(before); next.values.key = "after";
    const storage = new PluginStorageCoordinator(profile, { limitBytes: Buffer.byteLength(before) + Buffer.byteLength(JSON.stringify(next)) - 1 });
    await expect(new PrivatePluginStorage(profile, storage).set("example.plugin", "key", "after", c.ctx))
      .rejects.toMatchObject({ code: "resource-limit", reason: "limit" });
    expect(await fs.readFile(file, "utf8")).toBe(before); expect(await fs.readdir(join(profile, "plugin-data-v2"))).toHaveLength(2);
  });
});
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const dir of folders.splice(0)){
    const absolute=resolve(dir);
    if(!isPathInside(resolve(tmpdir()),absolute,{strict:true})||!basename(absolute).startsWith("herta-plugin-host-"))throw Error("Unsafe test cleanup target");
    const info=await fs.lstat(absolute).catch(()=>null);
    if(info?.isSymbolicLink())throw Error("Refuse linked test cleanup root");
    await fs.rm(absolute,{recursive:true,force:true});
  }
});

describe("real plugin workspace reads",()=>{
  it("returns bounded UTF8 from the actual workspace and strips a BOM",async()=>{
    const root=await folder(),c=context();await fs.writeFile(join(root,"notes.txt"),"\uFEFF黑塔\n42");
    expect(JSON.parse(await readPluginWorkspaceText(root,"notes.txt",undefined,c.ctx,[]))).toEqual({text:"黑塔\n42",bytes:12,sha256:createHash("sha256").update("\uFEFF黑塔\n42").digest("hex")});
  });
  it.each([".env",".git/config",".herta/private.json",".ssh/id_rsa"])("denies model-protected file %s",async path=>{
    const root=await folder(),c=context();
    await fs.mkdir(join(root,...path.split("/").slice(0,-1)),{recursive:true});await fs.writeFile(join(root,path),"synthetic secret");
    await expect(readPluginWorkspaceText(root,path,100,c.ctx,[])).rejects.toMatchObject({code:"capability-denied"});
  });
  it("denies protected application paths even when inside the selected workspace",async()=>{
    const root=await folder(),c=context(),profile=join(root,"profile");await fs.mkdir(profile);await fs.writeFile(join(profile,"ordinary.txt"),"private fixture");
    await expect(readPluginWorkspaceText(root,"profile/ordinary.txt",100,c.ctx,[profile])).rejects.toMatchObject({code:"capability-denied"});
  });
  it("denies a junction escaping the workspace but accepts a selected junction root",async()=>{
    const base=await folder(),root=join(base,"work"),outside=join(base,"outside"),c=context();await fs.mkdir(root);await fs.mkdir(outside);
    await fs.writeFile(join(outside,"text.txt"),"outside");await fs.symlink(outside,join(root,"jump"),"junction");
    await expect(readPluginWorkspaceText(root,"jump/text.txt",100,c.ctx,[])).rejects.toMatchObject({code:"capability-denied"});
    await fs.writeFile(join(root,"good.txt"),"inside");await fs.symlink(root,join(base,"alias"),"junction");
    expect(JSON.parse(await readPluginWorkspaceText(join(base,"alias"),"good.txt",100,c.ctx,[])).text).toBe("inside");
  });
  it("rejects an absolute/outside path instead of inheriting a full-access escape",async()=>{
    const base=await folder(),root=join(base,"work"),c=context();await fs.mkdir(root);await fs.writeFile(join(base,"outside.txt"),"outside");
    await expect(readPluginWorkspaceText(root,join(base,"outside.txt"),100,c.ctx,[])).rejects.toMatchObject({code:"capability-denied"});
  });
  it("refuses a project alias redirected after the run-start root was captured",async()=>{
    const base=await folder(),first=join(base,"first"),second=join(base,"second"),alias=join(base,"alias"),c=context();
    await fs.mkdir(first);await fs.mkdir(second);await fs.writeFile(join(second,"file.txt"),"other project");
    await fs.symlink(first,alias,"junction");const expected=await fs.realpath(alias);
    await fs.unlink(alias);await fs.symlink(second,alias,"junction");
    const opening=vi.spyOn(fs,"open");
    await expect(readPluginWorkspaceText(alias,"file.txt",100,c.ctx,[],expected)).rejects.toMatchObject({code:"capability-denied"});
    expect(opening).not.toHaveBeenCalled();
  });
  it("refuses large, binary, invalid UTF8 and JSON-expanding results without truncation",async()=>{
    const root=await folder(),c=context();
    for(const [name,bytes,limit,code] of [
      ["large.txt",Buffer.alloc(101,65),100,"resource-limit"],
      ["binary.txt",Buffer.from([65,0,66]),100,"invalid-input"],
      ["invalid.txt",Buffer.from([0xff,0xfe]),100,"invalid-input"],
      ["escaped.txt",Buffer.alloc(65536,1),65536,"resource-limit"],
    ] as const){await fs.writeFile(join(root,name),bytes);await expect(readPluginWorkspaceText(root,name,limit,c.ctx,[])).rejects.toMatchObject({code});}
    await expect(readPluginWorkspaceText(root,"large.txt",131073,c.ctx,[])).rejects.toMatchObject({code:"invalid-input"});
  });
  it("closes the opened file if cancellation occurs during open",async()=>{
    const root=await folder(),c=context();await fs.writeFile(join(root,"file.txt"),"fixture");
    const original=fs.open.bind(fs);let opened:Awaited<ReturnType<typeof fs.open>>|undefined;
    vi.spyOn(fs,"open").mockImplementation(async(p,flags,mode)=>{opened=await original(p,flags,mode);c.controller.abort();return opened;});
    await expect(readPluginWorkspaceText(root,"file.txt",100,c.ctx,[])).rejects.toMatchObject({code:"cancelled"});
    expect(opened?.fd).toBe(-1);
  });
  it("does not return bytes if the named file was replaced after opening",async()=>{
    const root=await folder(),file=join(root,"file.txt"),c=context();await fs.writeFile(file,"original");
    const original=fs.open.bind(fs);
    vi.spyOn(fs,"open").mockImplementation(async(p,flags,mode)=>{const handle=await original(p,flags,mode);await fs.rename(file,file+".old");await fs.writeFile(file,"replacement");return handle;});
    await expect(readPluginWorkspaceText(root,"file.txt",100,c.ctx,[])).rejects.toMatchObject({code:"capability-denied"});
  });
  it("reports fixed host errors and does not expose raw paths",async()=>{
    const root=await folder(),c=context();
    await expect(readPluginWorkspaceText(root,"missing.txt",100,c.ctx,[])).rejects.toMatchObject({code:"host-error",message:"host-error"});
    c.revoke();await expect(readPluginWorkspaceText(root,"missing.txt",100,c.ctx,[])).rejects.toMatchObject({code:"revoked"});
  });
});

describe("plugin-private atomic storage",()=>{
  it("does not create storage on a missing get, persists JSON and isolates namespaces",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),a=context(),b=context("other.plugin");
    expect(await store.get("example.plugin","key",a.ctx)).toBe("null");expect(await fs.readdir(profile)).toEqual([]);
    await store.set("example.plugin","key",{text:"hello",list:[1,false,null]},a.ctx);
    expect(JSON.parse(await new PrivatePluginStorage(profile).get("example.plugin","key",a.ctx))).toEqual({text:"hello",list:[1,false,null]});
    expect(await store.get("other.plugin","key",b.ctx)).toBe("null");
    await store.set("other.plugin","key","other",b.ctx);
    expect(JSON.parse(await store.get("example.plugin","key",a.ctx))).toHaveProperty("text","hello");
    expect((await fs.readdir(join(profile,"plugin-data-v2"))).every(name=>/^[a-f0-9]{64}\.json(?:\.backup)?$/.test(name))).toBe(true);
  });
  it.each(["../file","a/b","__proto__","constructor","prototype","", "x".repeat(81)])("rejects invalid storage key %s",async key=>{
    const store=new PrivatePluginStorage(await folder()),c=context();
    await expect(store.set("example.plugin",key,true,c.ctx)).rejects.toMatchObject({code:"invalid-input"});
  });
  it("refuses another plugin identity and invalid JSON data",async()=>{
    const store=new PrivatePluginStorage(await folder()),c=context();
    await expect(store.get("other.plugin","key",c.ctx)).rejects.toMatchObject({code:"invalid-input"});
    await expect(store.set("example.plugin","key",undefined,c.ctx)).rejects.toMatchObject({code:"invalid-input"});
    await expect(store.set("example.plugin","key","x".repeat(65536),c.ctx)).rejects.toMatchObject({code:"invalid-input"});
  });
  it("serializes concurrent updates instead of losing the earlier value",async()=>{
    const store=new PrivatePluginStorage(await folder()),c=context();
    await Promise.all([store.set("example.plugin","first",1,c.ctx),store.set("example.plugin","second",2,c.ctx)]);
    expect(await store.get("example.plugin","first",c.ctx)).toBe("1");expect(await store.get("example.plugin","second",c.ctx)).toBe("2");
  });
  it("preserves the old file after total-byte, key-count and aggregate-node limits",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),c=context();
    for(let i=0;i<5;i++)await store.set("example.plugin",`key${i}`,"x".repeat(50000),c.ctx);
    const file=storagePath(profile),before=await fs.readFile(file,"utf8");
    await expect(store.set("example.plugin","overflow","x".repeat(50000),c.ctx)).rejects.toMatchObject({reason:"limit"});expect(await fs.readFile(file,"utf8")).toBe(before);
    const record=JSON.parse(before);record.values=Object.fromEntries(Array.from({length:100},(_,i)=>[`key${i}`,i]));await fs.writeFile(file,JSON.stringify(record));
    await expect(store.set("example.plugin","extra",1,c.ctx)).rejects.toMatchObject({reason:"limit"});
    record.values={first:Array(4100).fill(0)};await fs.writeFile(file,JSON.stringify(record));
    await expect(store.set("example.plugin","second",Array(4100).fill(0),c.ctx)).rejects.toMatchObject({reason:"limit"});
    expect(JSON.parse(await fs.readFile(file,"utf8")).values).toHaveProperty("first");
    expect(JSON.parse(await fs.readFile(file,"utf8")).values).not.toHaveProperty("second");
  });
  it("does not silently reset damaged storage on read or write",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),c=context();await store.set("example.plugin","key",1,c.ctx);
    const file=storagePath(profile);await fs.writeFile(file,"{broken");
    await expect(store.get("example.plugin","key",c.ctx)).rejects.toBeInstanceOf(PluginStorageFault);
    await expect(store.set("example.plugin","key",2,c.ctx)).rejects.toMatchObject({reason:"damaged"});expect(await fs.readFile(file,"utf8")).toBe("{broken");
  });
  it("rejects a linked data directory and leaves the destination untouched",async()=>{
    const base=await folder(),profile=join(base,"profile"),outside=join(base,"outside"),c=context();await fs.mkdir(profile);await fs.mkdir(outside);
    await fs.symlink(outside,join(profile,"plugin-data-v2"),"junction");
    const store=new PrivatePluginStorage(profile);await expect(store.set("example.plugin","key",1,c.ctx)).rejects.toMatchObject({reason:"unavailable"});expect(await fs.readdir(outside)).toEqual([]);
  });
  it("rejects hardlinked namespace files instead of exposing another file",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),c=context();await store.set("example.plugin","key",1,c.ctx);
    await fs.link(storagePath(profile),join(profile,"outside-copy"));
    await expect(store.get("example.plugin","key",c.ctx)).rejects.toMatchObject({reason:"damaged"});
  });
  it("keeps old content on rename failure and removes only its temporary write",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),c=context();await store.set("example.plugin","key",1,c.ctx);
    vi.spyOn(fs,"rename").mockRejectedValueOnce(Object.assign(new Error("private path"),{code:"EACCES"}));
    await expect(store.set("example.plugin","key",2,c.ctx)).rejects.toMatchObject({code:"host-error"});
    expect(await store.get("example.plugin","key",c.ctx)).toBe("1");expect(await fs.readdir(join(profile,"plugin-data-v2"))).toHaveLength(2);
  });
  it("does not remove a pre-existing temporary-name collision",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),c=context();await store.set("example.plugin","key",1,c.ctx);
    const original=fs.open.bind(fs);let foreign="";
    vi.spyOn(fs,"open").mockImplementation(async(p,flags,mode)=>{
      if(flags==="wx"){foreign=String(p);await fs.writeFile(foreign,"pre-existing fixture");throw Object.assign(new Error("collision"),{code:"EEXIST"});}
      return original(p,flags,mode);
    });
    await expect(store.set("example.plugin","key",2,c.ctx)).rejects.toMatchObject({reason:"unavailable"});
    expect(await fs.readFile(foreign,"utf8")).toBe("pre-existing fixture");expect(await store.get("example.plugin","key",c.ctx)).toBe("1");
  });
  it("rejects a cancelled queued operation without poisoning later writes",async()=>{
    const profile=await folder(),store=new PrivatePluginStorage(profile),cancelled=context(),good=context();
    const first=store.set("example.plugin","cancelled",1,cancelled.ctx);cancelled.controller.abort();
    const second=store.set("example.plugin","good",2,good.ctx);
    await expect(first).rejects.toMatchObject({code:"cancelled"});await second;
    expect(await store.get("example.plugin","cancelled",good.ctx)).toBe("null");expect(await store.get("example.plugin","good",good.ctx)).toBe("2");
  });
});
