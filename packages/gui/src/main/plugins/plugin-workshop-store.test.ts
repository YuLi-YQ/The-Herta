import fsSync, { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { PluginWorkshopStore } from "./plugin-workshop-store.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";
import { ExecutablePluginStore } from "./executable-plugin-store.js";

const packageJson=JSON.stringify({manifest:{schemaVersion:2,apiVersion:1,id:"local.workshop",name:"合成制作",description:"",version:"1.0.0",entry:"main.js",capabilities:[],actions:[{id:"run",title:"运行",scope:"both",export:"run",inputs:[],capabilities:[]}]},files:[{path:"main.js",source:"export function run(){return 1;}"}]});
const model={providerId:"synthetic",modelId:"text-model",providerRevision:1};
const guard={signal:new AbortController().signal,assertCurrent(){}};
async function fixture(limitBytes=8192){const root=await fs.mkdtemp(join(tmpdir(),"herta-workshop-store-")),profile=join(root,"profile"),budget=new PluginStorageCoordinator(profile,{limitBytes});return{root,profile,budget,store:new PluginWorkshopStore(profile,budget)};}
describe("R145 isolated workshop storage",()=>{
  it("does not create folders on read, persists a separate candidate and counts the fifth namespace",async()=>{
    const f=await fixture();expect(await f.store.list(guard)).toEqual({items:[],unreadable:0});
    await expect(fs.lstat(f.profile)).rejects.toMatchObject({code:"ENOENT"});
    const made=await f.store.save({brief:"合成便笺",packageJson,model},guard);
    const again=await new PluginWorkshopStore(f.profile,f.budget).get(made.id,guard);
    expect(again).toEqual(made);expect(again.revision).toBe(1);expect(again.package.manifest.id).toBe("local.workshop");
    const use=await f.budget.snapshot(guard);expect(use.categories.find(item=>item.id==="workshop")?.usedBytes).toBeGreaterThan(0);
    expect(use.categories.find(item=>item.id==="packages")?.usedBytes).toBe(0);
    const listed=await new ExecutablePluginStore({profileDir:f.profile,chooseFile:async()=>undefined,storage:f.budget}).request({kind:"list"});
    expect(listed).toMatchObject({ok:true,snapshot:{items:[]}});if(listed.ok)expect(listed.snapshot.damaged).toBeUndefined();
  });
  it("requires the current revision, retains old bytes on cancellation and reports damaged drafts without emptying them",async()=>{
    const f=await fixture(),made=await f.store.save({brief:"first",packageJson,model},guard);
    const input={id:made.id,expectedRevision:1,brief:"second",packageJson,model};
    const [first,second]=await Promise.allSettled([f.store.save(input,guard),f.store.save(input,guard)]);
    expect(first.status).toBe("fulfilled");expect(second.status).toBe("rejected");expect((await f.store.get(made.id,guard)).revision).toBe(2);
    const file=join(f.profile,"plugin-workshop-v1",made.id,"draft.json"),before=await fs.readFile(file),abort=new AbortController();abort.abort();
    await expect(f.store.save({...input,expectedRevision:2},{...guard,signal:abort.signal})).rejects.toMatchObject({reason:"cancelled"});expect(await fs.readFile(file)).toEqual(before);
    await fs.writeFile(file,"{damaged-preserve");expect(await f.store.list(guard)).toEqual({items:[],unreadable:1,damagedIds:[made.id]});
    await expect(f.store.get(made.id,guard)).rejects.toMatchObject({reason:"damaged"});expect(await fs.readFile(file,"utf8")).toBe("{damaged-preserve");
    const invalidDate=JSON.parse(before.toString());invalidDate.updatedAt=0;await fs.writeFile(file,JSON.stringify(invalidDate));
    expect(await f.store.list(guard)).toEqual({items:[],unreadable:1,damagedIds:[made.id]});
    await fs.writeFile(file,Buffer.from([0xff,0xfe,0xff]));await expect(f.store.get(made.id,guard)).rejects.toMatchObject({reason:"damaged"});
  });
  it("refuses growth before staging when another namespace consumes the shared budget",async()=>{
    const f=await fixture(),made=await f.store.save({brief:"first",packageJson,model},guard),usage=await f.budget.snapshot(guard);
    await fs.mkdir(join(f.profile,"plugin-artifacts-v1"));await fs.writeFile(join(f.profile,"plugin-artifacts-v1","synthetic.bin"),Buffer.alloc(usage.availableBytes-1));
    const folder=join(f.profile,"plugin-workshop-v1",made.id),before=await fs.readFile(join(folder,"draft.json"));
    await expect(f.store.save({id:made.id,expectedRevision:1,brief:"changed",packageJson,model},guard)).rejects.toMatchObject({reason:"limit"});
    expect(await fs.readdir(folder)).toEqual(["draft.json"]);expect(await fs.readFile(join(folder,"draft.json"))).toEqual(before);
  });
  it("keeps a committed draft readable when publication cleanup fails, but rejects an outside hard link",async()=>{
    const f=await fixture(),original=fs.unlink.bind(fs),cleanup=vi.spyOn(fs,"unlink").mockImplementation(async path=>{
      if(String(path).includes(".draft-"))throw Object.assign(new Error("synthetic cleanup failure"),{code:"EACCES"});return original(path);
    });
    let id:string;try{id=(await f.store.save({brief:"first",packageJson,model},guard)).id;}finally{cleanup.mockRestore();}
    const draft=await f.store.get(id!,guard);expect(draft.package.manifest.id).toBe("local.workshop");
    const file=join(f.profile,"plugin-workshop-v1",id!,"draft.json"),bytes=(await fs.stat(file)).size;
    expect((await f.budget.snapshot(guard)).categories.find(item=>item.id==="workshop")?.usedBytes).toBe(bytes*2);
    await fs.link(file,join(f.root,"outside-link.json"));
    await expect(f.store.get(id!,guard)).rejects.toMatchObject({reason:"damaged"});
  });
  it("reclaims only its empty new directory when staging fails, so cancellation cannot consume draft slots",async()=>{
    const f=await fixture(),original=fs.open.bind(fs);
    const opening=vi.spyOn(fs,"open").mockImplementation(async(path,...args)=>{
      if(String(path).includes(".draft-"))throw Object.assign(new Error("synthetic staging failure"),{code:"EACCES"});
      return original(path,...args);
    });
    try{await expect(f.store.save({brief:"first",packageJson,model},guard)).rejects.toMatchObject({reason:"unavailable"});}finally{opening.mockRestore();}
    expect(await fs.readdir(join(f.profile,"plugin-workshop-v1"))).toEqual([]);
    expect(await f.store.list(guard)).toEqual({items:[],unreadable:0});
    expect((await f.store.save({brief:"retry",packageJson,model},guard)).revision).toBe(1);
  });
});

describe("R146 explicit draft deletion",()=>{
  it("previews damaged draft bytes without deleting and keeps the independently installed package",async()=>{
    const f=await fixture(),made=await f.store.save({brief:"first",packageJson,model},guard);
    const installed=new ExecutablePluginStore({profileDir:f.profile,chooseFile:async()=>undefined,storage:f.budget});
    const list=await installed.request({kind:"list"});if(!list.ok)throw Error("list");
    const p=await installed.previewGenerated(packageJson,list.snapshot.hostRevision,guard);
    expect((await installed.confirmGenerated(p.preview.id,p.snapshot.revision,[],p.snapshot.hostRevision,guard)).ok).toBe(true);
    const folder=join(f.profile,"plugin-workshop-v1",made.id),file=join(folder,"draft.json");await fs.writeFile(file,"{broken-draft");
    expect((await f.store.list(guard)).damagedIds).toEqual([made.id]);
    const preview=await f.store.prepareDelete(made.id,guard);expect(preview).toMatchObject({draftId:made.id,damaged:true,canConfirm:true,fileCount:1,bytes:13});
    expect(JSON.stringify(preview)).not.toContain(f.profile);expect(await fs.readFile(file,"utf8")).toBe("{broken-draft");
    expect(await f.store.confirmDelete(preview.id,guard)).toMatchObject({deleted:true,deletedFiles:1,remainingFiles:0});
    expect(await f.store.list(guard)).toEqual({items:[],unreadable:0});
    const after=await installed.request({kind:"list"});expect(after.ok&&after.snapshot.items.map(item=>item.manifest.id)).toEqual(["local.workshop"]);
    await expect(f.store.confirmDelete(preview.id,guard)).rejects.toMatchObject({reason:"changed"});
  });
  it("rejects changed contents and unsafe links, and cancelled confirmation leaves the draft",async()=>{
    const f=await fixture(),made=await f.store.save({brief:"first",packageJson,model},guard),folder=join(f.profile,"plugin-workshop-v1",made.id),file=join(folder,"draft.json");
    const preview=await f.store.prepareDelete(made.id,guard);await fs.appendFile(file," ");
    await expect(f.store.confirmDelete(preview.id,guard)).rejects.toMatchObject({reason:"changed"});expect((await fs.stat(file)).size).toBeGreaterThan(0);
    const next=await f.store.prepareDelete(made.id,guard),abort=new AbortController();abort.abort();
    await expect(f.store.confirmDelete(next.id,{...guard,signal:abort.signal})).rejects.toMatchObject({reason:"cancelled"});
    const outside=join(f.root,"outside.txt");await fs.writeFile(outside,"keep");
    await fs.link(outside,join(folder,".draft-11111111-1111-4111-8111-111111111111.tmp"));
    expect(await f.store.prepareDelete(made.id,guard)).toMatchObject({canConfirm:false,bytes:null,fileCount:null});expect(await fs.readFile(outside,"utf8")).toBe("keep");
  });
  it("reports a partial deletion and requires a fresh preview to finish",async()=>{
    const f=await fixture(),made=await f.store.save({brief:"first",packageJson,model},guard),folder=join(f.profile,"plugin-workshop-v1",made.id);
    await fs.writeFile(join(folder,".draft-11111111-1111-4111-8111-111111111111.tmp"),"residue");
    const preview=await f.store.prepareDelete(made.id,guard),original=fsSync.unlinkSync.bind(fsSync);let calls=0;
    const deleting=vi.spyOn(fsSync,"unlinkSync").mockImplementation(path=>{if(++calls===2)throw Object.assign(new Error("synthetic"),{code:"EACCES"});return original(path);});
    try{expect(await f.store.confirmDelete(preview.id,guard)).toMatchObject({deleted:false,deletedFiles:1,deletedBytes:7,remainingFiles:1});}finally{deleting.mockRestore();}
    expect((await f.store.get(made.id,guard)).id).toBe(made.id);
    await expect(f.store.confirmDelete(preview.id,guard)).rejects.toMatchObject({reason:"changed"});
    const fresh=await f.store.prepareDelete(made.id,guard);expect((await f.store.confirmDelete(fresh.id,guard)).deleted).toBe(true);
  });
});
