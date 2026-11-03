import { readFile, writeFile, rename, mkdir, copyFile, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parsePromptManifest, renderPrompt, PluginFault, type PluginSnapshot, type PromptManifest, type PluginReply, type PluginRequest } from "../shared/prompt-plugins.js";
const hash=(m:PromptManifest)=>createHash("sha256").update(JSON.stringify(m)).digest("hex");
const LIMIT=256*1024;
/** Line/column from V8's "position N"; the parser message itself may quote file content, so it is not shown. */
function jsonLocation(text:string,error:unknown):string{const position=Number(/position (\d+)/.exec(String((error as Error)?.message))?.[1]);if(!Number.isSafeInteger(position))return "";const lines=text.slice(0,position).split("\n");return `（第 ${lines.length} 行第 ${lines.at(-1)!.length+1} 列附近）`;}
export class PromptPluginStore {
 private queue:Promise<unknown>=Promise.resolve();
 private previews=new Map<string,{manifest:PromptManifest;expires:number}>();
 private file:string;
 constructor(private directory:string,private choose:()=>Promise<string|undefined>){this.file=join(directory,"plugins-v1.json");}
 private async load(file=this.file):Promise<PluginSnapshot>{
  try {
   if((await stat(file)).size>32*1024*1024)throw Error("size");
   const raw=JSON.parse(await readFile(file,"utf8"));
   if(raw.schemaVersion!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.items)||raw.items.length>100)throw Error("format");
   const items=raw.items.map((v:any)=>{const manifest=parsePromptManifest(v.manifest);if(typeof v.enabled!=="boolean"||v.contentHash!==hash(manifest)||typeof v.installedAt!=="string"||typeof v.updatedAt!=="string")throw Error("format");return {manifest,enabled:v.enabled,contentHash:v.contentHash,installedAt:v.installedAt,updatedAt:v.updatedAt};});
   if(new Set(items.map((x:any)=>x.manifest.id)).size!==items.length)throw Error("duplicates");
   return {revision:raw.revision,items};
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT"&&file===this.file)return {revision:0,items:[]};return {revision:0,items:[],damaged:true};}
 }
 private async save(next:PluginSnapshot,backup=true){
  await mkdir(this.directory,{recursive:true});
  const temp=this.file+".tmp";
  await writeFile(temp,JSON.stringify({schemaVersion:1,...next}),"utf8");
  if(backup)try{await copyFile(this.file,this.file+".bak");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  await rename(temp,this.file);
 }
 async request(raw:PluginRequest):Promise<PluginReply>{
  const run=this.queue.then(()=>this.perform(raw)).catch((e):PluginReply=>({ok:false,message:e instanceof PluginFault?e.message:"插件操作未保存，请稍后重试；现有草稿不受影响。"}));this.queue=run;return run;
 }
 private async perform(raw:PluginRequest):Promise<PluginReply>{
  if(!raw||typeof raw!=="object"||typeof raw.kind!=="string")throw new PluginFault("插件请求格式不正确。");
  let snapshot=await this.load();
  if(raw.kind==="list")return {ok:true,snapshot};
  if(raw.kind==="discard"){this.previews.delete(raw.previewId);return {ok:true,snapshot};}
  if(raw.kind==="restore"){
   if(!snapshot.damaged)throw new PluginFault("当前插件记录无需恢复。");
   const previous=await this.load(this.file+".bak");if(previous.damaged)throw new PluginFault("没有可用的插件备份。可以选择“另存损坏记录并重新开始”，原文件会保留。");
   await copyFile(this.file,this.file+".damaged-"+Date.now());
   snapshot={...previous,revision:previous.revision+1};await this.save(snapshot,false);return {ok:true,snapshot};
  }
  if(raw.kind==="reset"){
   if(!snapshot.damaged)throw new PluginFault("当前插件记录无需重新开始。");
   await copyFile(this.file,this.file+".damaged-"+Date.now());
   snapshot={revision:1,items:[]};await this.save(snapshot,false);return {ok:true,snapshot};
  }
  if(snapshot.damaged)throw new PluginFault("插件记录损坏，请先在设置中恢复备份或重新开始；原文件已保留。");
  if(raw.kind==="preview"){
   const path=await this.choose();if(!path)return {ok:true,snapshot};
   let bytes:Buffer;
   try{
    if((await stat(path)).size>LIMIT)throw new PluginFault("插件文件不能超过 256 KiB。");
    const handle=await open(path,"r");
    try{const buffer=Buffer.alloc(LIMIT+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);bytes=buffer.subarray(0,bytesRead);}finally{await handle.close();}
   }catch(e){if(e instanceof PluginFault)throw e;throw new PluginFault("无法读取所选文件，请确认文件仍存在且有读取权限。");}
   if(bytes.length>LIMIT)throw new PluginFault("插件文件不能超过 256 KiB。");
   let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new PluginFault("文件不是有效的 UTF-8 文本，请以 UTF-8 编码保存后重试。");}
   if(!text.trim())throw new PluginFault("插件文件为空。");
   let parsed:unknown;try{parsed=JSON.parse(text);}catch(e){throw new PluginFault(`JSON 格式错误${jsonLocation(text,e)}。常见原因：注释、尾随逗号、缺少引号或逗号。`);}
   const manifest=parsePromptManifest(parsed),id=randomUUID();
   for(const [k,v] of this.previews)if(v.expires<Date.now())this.previews.delete(k);
   while(this.previews.size>=4)this.previews.delete(this.previews.keys().next().value!);
   this.previews.set(id,{manifest,expires:Date.now()+600000});
   const existing=snapshot.items.find(x=>x.manifest.id===manifest.id);
   return {ok:true,snapshot,preview:{id,manifest,existing,identical:existing?.contentHash===hash(manifest)}};
  }
  if(raw.kind==="prepare"){
   const item=snapshot.items.find(x=>x.manifest.id===raw.id);
   const action=item?.manifest.actions.find(x=>x.id===raw.actionId);
   if(!item?.enabled||item.contentHash!==raw.contentHash||!action||!["chat","workbench"].includes(raw.scope)||(action.scope!=="both"&&action.scope!==raw.scope))throw new PluginFault("插件已停用、更新或移除，请重新选择动作。");
   return {ok:true,snapshot,text:renderPrompt(action,raw.values)};
  }
  if(!("revision" in raw)||raw.revision!==snapshot.revision)throw new PluginFault("插件列表已变化，请刷新后重试。");
  let items=[...snapshot.items];
  if(raw.kind==="install"){
   const preview=this.previews.get(raw.previewId);if(!preview||preview.expires<Date.now())throw new PluginFault("安装预览已过期，请重新导入。");
   const old=items.find(x=>x.manifest.id===preview.manifest.id);
   if(!old&&items.length>=100)throw new PluginFault("插件数量已达到100个，请先移除不需要的插件。");
   const now=new Date().toISOString(),item={manifest:preview.manifest,enabled:old?.enabled??true,contentHash:hash(preview.manifest),installedAt:old?.installedAt??now,updatedAt:now};
   items=items.filter(x=>x.manifest.id!==item.manifest.id);items.push(item);
  }else if(raw.kind==="enable"||raw.kind==="remove"){
   if(!items.some(x=>x.manifest.id===raw.id))throw new PluginFault("插件已不存在，请刷新列表。");
   if(raw.kind==="enable"){if(typeof raw.enabled!=="boolean")throw new PluginFault("启用状态格式不正确。");items=items.map(x=>x.manifest.id===raw.id?{...x,enabled:raw.enabled}:x);}
   else items=items.filter(x=>x.manifest.id!==raw.id);
  }else throw new PluginFault("不支持的插件操作。");
  snapshot={revision:snapshot.revision+1,items};await this.save(snapshot);
  if(raw.kind==="install")this.previews.delete(raw.previewId);
  return {ok:true,snapshot};
 }
}
