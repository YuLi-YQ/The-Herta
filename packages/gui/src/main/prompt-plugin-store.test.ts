// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PromptPluginStore } from "./prompt-plugin-store.js";
import { parsePromptManifest, renderPrompt } from "../shared/prompt-plugins.js";
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const manifest=()=>({schemaVersion:1,id:"local.example",name:"测试插件",version:"1.0.0",description:"测试",actions:[{id:"review",title:"检查",scope:"both",prompt:"检查 {{request}}",inputs:[{id:"request",label:"内容",type:"text",required:true}]}]});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),"herta-plugin-"));dirs.push(dir);const input=join(dir,"input.json");await writeFile(input,JSON.stringify(manifest()));const store=new PromptPluginStore(dir,async()=>input);return {dir,input,store};}
async function install(store:PromptPluginStore){const p=await store.request({kind:"preview"});if(!p.ok||!p.preview)throw Error("preview");const r=await store.request({kind:"install",previewId:p.preview.id,revision:p.snapshot.revision});if(!r.ok)throw Error(r.message);return r.snapshot;}
it("validates schemas, duplicate IDs, unsupported capabilities, and performs only a single substitution",()=>{
 const m=parsePromptManifest(manifest());expect(renderPrompt(m.actions[0]!,{request:"{{request}}"})).toBe("检查 {{request}}");
 expect(()=>parsePromptManifest({...manifest(),script:"x"})).toThrow();
 expect(()=>parsePromptManifest({...manifest(),actions:[...manifest().actions,...manifest().actions]})).toThrow();
 expect(()=>renderPrompt(m.actions[0]!,{request:" "})).toThrow();
 expect(()=>renderPrompt(m.actions[0]!,{request:"x",file:"secret"})).toThrow();
});
it("installs an immutable preview, persists enabled state, and rejects stale revision and stale actions",async()=>{
 const {input,dir,store}=await fixture();const p=await store.request({kind:"preview"});if(!p.ok||!p.preview)throw Error();
 await writeFile(input,JSON.stringify({...manifest(),name:"changed"}));
 const r=await store.request({kind:"install",previewId:p.preview.id,revision:0});if(!r.ok)throw Error();expect(r.snapshot.items[0]?.manifest.name).toBe("测试插件");
 const item=r.snapshot.items[0]!;
 expect((await store.request({kind:"enable",id:item.manifest.id,enabled:false,revision:0})).ok).toBe(false);
 const prepared=await store.request({kind:"prepare",id:item.manifest.id,actionId:"review",contentHash:item.contentHash,scope:"chat",values:{request:"hello"}});expect(prepared.ok&&prepared.text).toBe("检查 hello");
 await store.request({kind:"enable",id:item.manifest.id,enabled:false,revision:1});
 const loaded=await new PromptPluginStore(dir,async()=>input).request({kind:"list"});expect(loaded.ok&&loaded.snapshot.items[0]?.enabled).toBe(false);
 expect((await store.request({kind:"prepare",id:item.manifest.id,actionId:"review",contentHash:item.contentHash,scope:"chat",values:{request:"x"}})).ok).toBe(false);
});
it("keeps the installed version on failed writes, resolves concurrent changes with revision checks, and recovers corruption",async()=>{
 const {store,dir,input}=await fixture();const s=await install(store);
 const results=await Promise.all([store.request({kind:"enable",id:"local.example",enabled:false,revision:s.revision}),store.request({kind:"remove",id:"local.example",revision:s.revision})]);expect(results.map(r=>r.ok)).toEqual([true,false]);
 await mkdir(join(dir,"plugins-v1.json.tmp"));
 expect((await store.request({kind:"remove",id:"local.example",revision:2})).ok).toBe(false);
 expect((await readFile(join(dir,"plugins-v1.json"),"utf8"))).toContain("local.example");
 await rm(join(dir,"plugins-v1.json.tmp"),{recursive:true});
 await writeFile(join(dir,"plugins-v1.json"),"bad");const broken=await store.request({kind:"list"});expect(broken.ok&&broken.snapshot.damaged).toBe(true);
 const restored=await store.request({kind:"restore"});expect(restored.ok&&restored.snapshot.items).toHaveLength(1);expect(await readFile(input,"utf8")).toContain("local.example");
});
it("updates retain disabled status and invalidate old content hashes; removal leaves source files",async()=>{
 const {store,input}=await fixture();const old=await install(store);await store.request({kind:"enable",id:"local.example",enabled:false,revision:1});
 await writeFile(input,JSON.stringify({...manifest(),version:"1.1.0"}));const next=await install(store);expect(next.items[0]?.enabled).toBe(false);expect(next.items[0]?.contentHash).not.toBe(old.items[0]?.contentHash);
 await store.request({kind:"remove",id:"local.example",revision:next.revision});expect(await readFile(input,"utf8")).toContain("1.1.0");
});

it("locates manifest errors by action, input and field",()=>{
 const fault=(raw:unknown)=>{try{parsePromptManifest(raw);}catch(e){return (e as Error).message;}throw Error("accepted");};
 const second={id:"second",title:"第二",scope:"chat",prompt:"{{request}}",inputs:[{id:"request",label:" ",type:"text",required:true}]};
 expect(fault({...manifest(),script:"x"})).toContain("不支持字段“script”");
 const {name:_,...unnamed}=manifest();expect(fault(unnamed)).toBe("name：缺少此字段。");
 expect(fault({...manifest(),actions:[...manifest().actions,second]})).toBe("第2个动作（second） · 第1个参数（request） · label：不能为空。");
 expect(fault({...manifest(),actions:[{...manifest().actions[0],prompt:"检查 {{missing}}"}]})).toContain("第1个动作（review） · prompt：引用了未定义参数 {{missing}}");
 expect(fault({...manifest(),actions:[{...manifest().actions[0],prompt:"检查 {{ request }}"}]})).toContain("prompt：占位符只能写成");
 expect(fault({...manifest(),actions:[{...manifest().actions[0],inputs:[{id:"level",label:"级别",type:"select",required:false,options:["低","高"],default:"中"}],prompt:"{{level}}"}]})).toBe("第1个动作（review） · 第1个参数（level） · default：默认值必须是选项之一。");
 expect(fault({...manifest(),actions:[...manifest().actions,...manifest().actions]})).toBe("actions：动作标识“review”重复。");
});
it("reports unreadable, non-UTF-8, empty and malformed files with a location but without file content",async()=>{
 const {store,input,dir}=await fixture();const message=async()=>{const r=await store.request({kind:"preview"});if(r.ok)throw Error("accepted");return r.message;};
 await writeFile(input,'{\n  "schemaVersion": 1,\n  "name": "secret-value" "id": "x"\n}');const malformed=await message();expect(malformed).toContain("JSON 格式错误（第 3 行");expect(malformed).not.toContain("secret-value");
 await writeFile(input,Buffer.from([0x7b,0xff,0xfe,0x7d]));expect(await message()).toContain("UTF-8");
 await writeFile(input,"  \n");expect(await message()).toBe("插件文件为空。");
 const missing=new PromptPluginStore(dir,async()=>join(dir,"missing.json"));const r=await missing.request({kind:"preview"});expect(!r.ok&&r.message).toContain("无法读取所选文件");
});
it("offers an explicit fresh start when corruption has no usable backup and keeps the damaged file",async()=>{
 const {store,dir}=await fixture();await install(store);
 expect((await store.request({kind:"reset"})).ok).toBe(false);
 await writeFile(join(dir,"plugins-v1.json"),"bad");
 const restore=await store.request({kind:"restore"});expect(!restore.ok&&restore.message).toContain("重新开始");
 const reset=await store.request({kind:"reset"});expect(reset.ok&&reset.snapshot).toEqual({revision:1,items:[]});
 const kept=(await readdir(dir)).filter(f=>f.startsWith("plugins-v1.json.damaged-"));expect(kept).toHaveLength(1);expect(await readFile(join(dir,kept[0]!),"utf8")).toBe("bad");
 expect((await install(store)).items).toHaveLength(1);
});
it("expires cancelled previews and rejects oversized or executable-format files",async()=>{
 const {store,input}=await fixture();const p=await store.request({kind:"preview"});if(!p.ok||!p.preview)throw Error();
 await store.request({kind:"discard",previewId:p.preview.id});expect((await store.request({kind:"install",previewId:p.preview.id,revision:0})).ok).toBe(false);
 await writeFile(input," ".repeat(256*1024+1));expect((await store.request({kind:"preview"})).ok).toBe(false);
 await writeFile(input,JSON.stringify({...manifest(),entry:"plugin.js"}));expect((await store.request({kind:"preview"})).ok).toBe(false);
 const r=await store.request({kind:"list"});expect(r.ok&&r.snapshot.items).toEqual([]);
});
