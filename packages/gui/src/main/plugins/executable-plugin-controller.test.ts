import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExecutablePluginAction, ExecutablePluginCapabilityName } from "../../shared/executable-plugins.js";
import type { ExecutablePluginReply, ExecutablePluginRunView } from "../../shared/executable-plugin-management.js";
import type { PluginRunRequest, PluginRunResult } from "../../shared/plugin-runtime.js";
import type { PluginTask } from "./plugin-runtime-service.js";
import { PluginCapabilityBroker } from "./capability-broker.js";
import { ExecutablePluginStore } from "./executable-plugin-store.js";
import { createExecutablePluginController, type ExecutablePluginOwner } from "./executable-plugin-controller.js";
import { PluginNetworkFault, createPluginNetworkService } from "./plugin-network-service.js";
import { PluginNetworkSettingsStore, PLUGIN_NETWORK_SETTINGS_FILE } from "./plugin-network-settings-store.js";
import { PLUGIN_NETWORK_DEFAULT_CONFIG } from "../../shared/plugin-network-settings.js";
import { PluginStorageCoordinator } from "./plugin-storage-coordinator.js";
import { PluginCommandFault, type PluginCommandContext, type PluginCommandInput, type PluginCommandResult } from "@herta/tools";

class Runtime {
  tasks: { broker: PluginCapabilityBroker; request: PluginRunRequest; task: PluginTask; finish(result?: PluginRunResult): void }[]=[];
  start(request:PluginRunRequest,broker:PluginCapabilityBroker){
    let resolve!:(value:PluginRunResult)=>void,done=false;
    const result=new Promise<PluginRunResult>(r=>{resolve=r});
    const abort=()=>finish({ok:false,code:"revoked"});
    const finish=(value:PluginRunResult={ok:true,valueJson:'42'})=>{
      if(done)return;done=true;broker.signal.removeEventListener("abort",abort);broker.dispose();resolve(value);
    };
    const task={id:String(this.tasks.length+1),accepted:true,result,closed:result.then<void>(()=>undefined),cancel:()=>finish({ok:false,code:"cancelled"})};
    broker.signal.addEventListener("abort",abort,{once:true});
    this.tasks.push({broker,request,task,finish});return task;
  }
  dispose(){this.tasks.forEach(t=>t.task.cancel())}
}
async function fixture(capabilities:ExecutablePluginCapabilityName[]=["draft.append","storage.get","storage.set","log","progress"],actions?:readonly ExecutablePluginAction[],allowPatch=false,networkOptions?:{network:NonNullable<Parameters<typeof createExecutablePluginController>[0]["network"]>;authorize?:()=>Promise<boolean>;command?:Parameters<typeof createExecutablePluginController>[0]["command"]},budgetLimit?:number,workshopGenerator?:Parameters<typeof createExecutablePluginController>[0]["workshopGenerator"]){
  const root=await mkdtemp(join(tmpdir(),"herta-plugin-controller-")),profile=join(root,"profile"),workspace=join(root,"workspace"),file=join(root,"plugin.json");
  await mkdir(workspace);await writeFile(join(workspace,"input.txt"),"synthetic workspace text");
  await writeFile(file,JSON.stringify({manifest:{schemaVersion:2,apiVersion:1,id:"example.controller",name:"Sample",version:"1.0.0",description:"",entry:"main.js",capabilities:capabilities.map(name=>name==="network.request"?{name,origins:["https://example.com"],methods:["GET","POST"]}:{name}),actions:actions??[{id:"run",title:"Run",scope:capabilities.some(cap=>cap.startsWith("workspace.")||cap==="commands.run")?"workbench":"both",export:"run",inputs:[],capabilities}]},files:[{path:"main.js",source:"export function run(){return 42;}"}]}));
  const budget=new PluginStorageCoordinator(profile,budgetLimit===undefined?{}:{limitBytes:budgetLimit});
  const store=new ExecutablePluginStore({profileDir:profile,storage:budget,chooseFile:async()=>file});
  const preview=await store.request({kind:"preview"});if(!preview.ok||!preview.preview)throw Error("preview");
  const installed=await store.request({kind:"confirm",revision:preview.snapshot.revision,previewId:preview.preview.id,grants:capabilities});if(!installed.ok)throw Error("install");
  const item=installed.snapshot.items[0]!;
  let owner:ExecutablePluginOwner={id:"current",revision:1,busy:false,permissionMode:"workspace-edit",permissionRevision:1,planActive:false,workspaceRoot:workspace};
  const runtime=new Runtime();
  let applyCalls = 0;
  const controller=createExecutablePluginController({store,runtime,profile,storage:budget,protectedPaths:[profile],owner:()=>owner,
    ...(workshopGenerator?{workshopGenerator}:{}),
    ...(networkOptions?{network:networkOptions.network,command:networkOptions.command}:{}),
    ...(allowPatch?{withWorkspaceOperation:async<T>(_owner:unknown,_root:string,signal:AbortSignal,work:(lease:import("@herta/app-server").WorkspaceOperationContext)=>Promise<T>)=>{applyCalls++;return work({signal,assertCurrent(){},authorizeFileChange:async()=>true,authorizeNetworkRequest:networkOptions?.authorize??(async()=>true),authorizeCommand:networkOptions?.authorize??(async()=>true)});}}:{}),
  });
  const input={kind:"run" as const,pluginId:item.manifest.id,contentHash:item.contentHash,actionId:"run",scope:"workbench" as const,target:owner.id,inputJson:"{}",draftRevision:7};
  const change=(patch:Partial<ExecutablePluginOwner>)=>{owner={...owner,...patch};};
  return{root,profile,workspace,file,store,item,runtime,controller,input,change,budget,applyCalls:()=>applyCalls};
}
function runView(reply:ExecutablePluginReply):ExecutablePluginRunView{
  if(!reply.ok||!reply.run)throw Error("Expected run");return reply.run;
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

it("R147 parent settings route revokes an old network policy and blocks corrupt settings before transport",async()=>{
  const f=await fixture(["network.request"]),settings=new PluginNetworkSettingsStore(f.profile),runtime=new Runtime();
  let resolveStarted!:()=>void;const started=new Promise<void>(resolve=>{resolveStarted=resolve});
  const resolve=vi.fn(async(_hostname:string,signal:AbortSignal)=>{resolveStarted();return new Promise<readonly {address:string;family:4}[]>(done=>signal.addEventListener("abort",()=>done([]),{once:true}));});
  const send=vi.fn(()=>{throw Error("No actual connection permitted")});
  const network=createPluginNetworkService({getEgressPolicy:()=>settings.current(),resolve,request:send});
  const controller=createExecutablePluginController({store:f.store,runtime,profile:f.profile,networkSettings:settings,network,protectedPaths:[f.profile],owner:()=>({id:"chat",revision:1,busy:false,permissionMode:"read-only",permissionRevision:1,planActive:false})});
  try{
    const loaded=await controller.request({kind:"network-settings-get"});if(!loaded.ok||!loaded.networkSettings)throw Error("settings");
    expect(loaded.networkSettings).toEqual({revision:0,config:PLUGIN_NETWORK_DEFAULT_CONFIG});
    expect((await controller.request({kind:"network-settings-get",path:f.profile})).ok).toBe(false);
    await controller.request({...f.input,scope:"chat",target:"chat"});
    const pending=runtime.tasks.at(-1)!.broker.call("network.request",'{"url":"https://example.com/data","method":"GET"}');await started;
    const saved=await controller.request({kind:"network-settings-set",expectedRevision:0,config:{...PLUGIN_NETWORK_DEFAULT_CONFIG,mode:"proxy",proxyUrl:"http://127.0.0.1:8080"}});
    expect(saved.ok&&saved.networkSettings?.revision).toBe(1);
    expect(await pending).toEqual({ok:false,code:"revoked"});expect(send).not.toHaveBeenCalled();
    const resolving=resolve.mock.calls.length;await writeFile(join(f.profile,PLUGIN_NETWORK_SETTINGS_FILE),"{synthetic corrupt policy");
    await controller.request({...f.input,scope:"chat",target:"chat"});
    expect(await runtime.tasks.at(-1)!.broker.call("network.request",'{"url":"https://example.com/data","method":"GET"}')).toEqual({ok:false,code:"capability-denied"});
    expect(resolve).toHaveBeenCalledTimes(resolving);expect(send).not.toHaveBeenCalled();
    const bad=await controller.request({kind:"network-settings-get"});expect(bad.ok&&bad.networkSettings?.loadError).toBeTruthy();
  }finally{controller.dispose();f.controller.dispose();}
});

it("R146 routes authoring through the parent controller and closes conflicting maintenance and run admission",async()=>{
  let complete!:(value:{packageJson:string;providerId:string;modelId:string;providerRevision:number;outputBytes:number})=>void;
  const pending=new Promise<{packageJson:string;providerId:string;modelId:string;providerRevision:number;outputBytes:number}>(resolve=>{complete=resolve});
  const f=await fixture(undefined,undefined,false,undefined,undefined,{generate:async()=>pending});try{
    const model={providerId:"synthetic",modelId:"synthetic-model",providerRevision:1};
    const started=await f.controller.request({kind:"workshop-generate",target:null,brief:"synthetic authoring",model});
    if(!started.ok||!started.job)throw Error("job");
    expect((await f.controller.request(f.input)).ok).toBe(false);
    expect((await f.controller.request({kind:"maintenance-preview",hostRevision:f.store.hostRevision})).ok).toBe(false);
    expect((await f.controller.request({kind:"preview"})).ok).toBe(false);
    complete({packageJson:await readFile(f.file,"utf8"),...model,outputBytes:500});
    await vi.waitFor(async()=>{const reply=await f.controller.request({kind:"workshop-status",jobId:started.job!.id});expect(reply.ok&&reply.job?.busy).toBe(false);});
    const list=await f.controller.request({kind:"workshop-list"});expect(list.ok&&list.drafts?.items).toHaveLength(1);
    expect((await f.controller.request(f.input)).ok).toBe(true);
  }finally{f.controller.dispose();}
});

describe("R142 storage budget controller",()=>{
  it("returns only category totals and rejects renderer paths without starting a plugin",async()=>{
    const f=await fixture();try{
      const before=await f.controller.request({kind:"list"});
      const reply=await f.controller.request({kind:"storage-usage"});
      expect(reply.ok&&reply.storage).toMatchObject({status:"ready",limitBytes:512*1024*1024,overLimit:false});
      if(!reply.ok||!reply.storage)throw Error("usage");
      expect(reply.storage.categories.map(item=>item.id)).toEqual(["packages","private-data","artifacts","proposals","workshop"]);
      expect(reply.storage.usedBytes).toBeGreaterThan(0);expect(JSON.stringify(reply)).not.toContain(f.profile);
      expect((await f.controller.request({kind:"storage-usage",path:f.workspace})).ok).toBe(false);
      expect(await f.controller.request({kind:"list"})).toEqual(before);expect(f.runtime.tasks).toHaveLength(0);
    }finally{f.controller.dispose();}
  });
  it("shares injected limits across the installed package, private values and generated artifacts",async()=>{
    const f=await fixture(["storage.set","storage.get","artifacts.create"],undefined,false,undefined,16384);try{
      const reply=await f.controller.request({kind:"storage-usage"});if(!reply.ok||!reply.storage)throw Error("usage");
      await mkdir(join(f.profile,"plugin-patches-v2"),{recursive:true});
      await writeFile(join(f.profile,"plugin-patches-v2","synthetic-residue.tmp"),"x".repeat(reply.storage.availableBytes-1));
      runView(await f.controller.request(f.input));const broker=f.runtime.tasks[0]!.broker;
      expect((await broker.call("storage.set",'{"key":"value","value":"new"}')).ok).toBe(false);
      expect(await broker.call("storage.get",'{"key":"value"}')).toEqual({ok:true,valueJson:"null"});
      expect((await broker.call("artifacts.create",'{"name":"new.txt","mime":"text/plain","text":"new"}')).ok).toBe(false);
      const after=await f.controller.request({kind:"storage-usage"});expect(after.ok&&after.storage?.availableBytes).toBe(1);
    }finally{f.controller.dispose();}
  });
  it("cancels a queued usage scan when the host closes instead of returning a stale snapshot",async()=>{
    const f=await fixture();let release!:()=>void;try{
      let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve});
      const lock=f.budget.withWrite(0,{signal:new AbortController().signal,assertCurrent(){}},async()=>{entered();await new Promise<void>(resolve=>{release=resolve});});
      await ready;const pending=f.controller.request({kind:"storage-usage"});f.controller.dispose();release();await lock;
      expect(await pending).toMatchObject({ok:false,message:"插件资料操作已取消。"});
    }finally{release?.();f.controller.dispose();}
  });
});

describe("R143 private data management controller",()=>{
  it("previews metadata then restores explicitly, while refusing running plugins and unknown fields",async()=>{
    const f=await fixture(["storage.set","storage.get"]);try{
      runView(await f.controller.request(f.input));const task=f.runtime.tasks[0]!;
      expect((await task.broker.call("storage.set",'{"key":"label","value":"synthetic-private-first"}')).ok).toBe(true);
      expect((await task.broker.call("storage.set",'{"key":"label","value":"synthetic-private-second"}')).ok).toBe(true);
      const ask={kind:"private-data-preview",pluginId:f.item.manifest.id,action:"restore",hostRevision:f.store.hostRevision};
      expect(await f.controller.request(ask)).toMatchObject({ok:false,message:expect.stringContaining("等待插件")});
      task.finish();await settle();
      expect((await f.controller.request({...ask,path:f.profile})).ok).toBe(false);
      expect((await f.controller.request({...ask,pluginId:"unknown.plugin"})).ok).toBe(false);
      const reply=await f.controller.request(ask);if(!reply.ok||!reply.privateDataPreview)throw Error("metadata preview");
      expect(reply.privateDataPreview).toMatchObject({canConfirm:true,current:{state:"valid",keys:1},backup:{state:"valid",keys:1}});
      expect(JSON.stringify(reply)).not.toMatch(/synthetic-private|profile|values/);
      const confirm={kind:"private-data-confirm",previewId:reply.privateDataPreview.id,hostRevision:f.store.hostRevision};
      expect(await f.controller.request(confirm)).toMatchObject({ok:true,privateDataResult:{action:"restore",keys:1,archived:true}});
      expect((await f.controller.request(confirm)).ok).toBe(false);
      runView(await f.controller.request(f.input));
      expect(await f.runtime.tasks.at(-1)!.broker.call("storage.get",'{"key":"label"}')).toEqual({ok:true,valueJson:'"synthetic-private-first"'});
    }finally{f.controller.dispose();}
  });
  it("rejects a preview after installation changes and closes the launch gate during maintenance",async()=>{
    const f=await fixture();try{
      const revision=f.store.hostRevision;
      const reply=await f.controller.request({kind:"private-data-preview",pluginId:f.item.manifest.id,action:"reset",hostRevision:revision});
      if(!reply.ok||!reply.privateDataPreview)throw Error("preview");
      const listed=await f.store.request({kind:"list"});if(!listed.ok)throw Error("list");
      await f.store.request({kind:"enable",id:f.item.manifest.id,enabled:false,revision:listed.snapshot.revision});
      expect((await f.controller.request({kind:"private-data-confirm",previewId:reply.privateDataPreview.id,hostRevision:revision})).ok).toBe(false);
      const original=f.budget.snapshot.bind(f.budget);let release!:()=>void,entered!:()=>void;
      const ready=new Promise<void>(resolve=>{entered=resolve});
      vi.spyOn(f.budget,"snapshot").mockImplementation(async guard=>{entered();await new Promise<void>(resolve=>{release=resolve});return original(guard);});
      const pending=f.controller.request({kind:"private-data-preview",pluginId:f.item.manifest.id,action:"reset",hostRevision:f.store.hostRevision});
      await ready;
      expect(await f.controller.request(f.input)).toMatchObject({ok:false,message:expect.stringContaining("处理插件资料")});
      release();expect((await pending).ok).toBe(true);expect(f.runtime.tasks).toHaveLength(0);
    }finally{f.controller.dispose();}
  });
});

describe("R144 maintenance admission controller",()=>{
  it("only accepts host candidate IDs and closes new operations while confirmed cleanup is pending",async()=>{
    const f=await fixture();let release!:()=>void;try{
      const temp=join(f.profile,"plugins-v2","index.json.tmp-11111111-1111-4111-8111-111111111111");await writeFile(temp,"synthetic residue");
      const hostRevision=f.store.hostRevision;
      expect((await f.controller.request({kind:"maintenance-preview",hostRevision,path:f.profile})).ok).toBe(false);
      const reply=await f.controller.request({kind:"maintenance-preview",hostRevision});if(!reply.ok||!reply.maintenancePreview)throw Error("maintenance preview");
      expect(JSON.stringify(reply)).not.toContain(f.profile);const item=reply.maintenancePreview.items.find(item=>item.category==="temporary")!;
      const confirm={kind:"maintenance-confirm",hostRevision,previewId:reply.maintenancePreview.id,selectedIds:[item.id]};
      expect((await f.controller.request({...confirm,selectedIds:[item.id,item.id]})).ok).toBe(false);
      const original=f.budget.deleteConfirmedMaintenance.bind(f.budget);let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve});
      vi.spyOn(f.budget,"deleteConfirmedMaintenance").mockImplementation(async(...args)=>{entered();await new Promise<void>(resolve=>{release=resolve});return original(...args);});
      const pending=f.controller.request(confirm);await ready;
      expect((await f.controller.request(f.input)).ok).toBe(false);
      expect((await f.controller.request({kind:"preview"})).ok).toBe(false);
      expect((await f.controller.request({kind:"private-data-preview",pluginId:f.item.manifest.id,action:"reset",hostRevision})).ok).toBe(false);
      expect((await f.controller.request({kind:"outputs-list",scope:"workbench",target:f.input.target})).ok).toBe(false);
      release();expect(await pending).toMatchObject({ok:true,maintenanceResult:{deletedCount:1,failedCount:0}});
      await expect(readFile(temp)).rejects.toMatchObject({code:"ENOENT"});expect(f.runtime.tasks).toHaveLength(0);
      expect((await f.controller.request(confirm)).ok).toBe(false);
    }finally{release?.();f.controller.dispose();}
  });
  it("refuses both asynchronous launch and running work without cancelling them",async()=>{
    const f=await fixture();let release!:()=>void;try{
      let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve}),original=f.store.resolve.bind(f.store);
      vi.spyOn(f.store,"resolve").mockImplementation(async(...args)=>{entered();await new Promise<void>(resolve=>{release=resolve});return original(...args);});
      const running=f.controller.request(f.input);await ready;
      const query={kind:"maintenance-preview",hostRevision:f.store.hostRevision};
      expect(await f.controller.request(query)).toMatchObject({ok:false,message:expect.stringContaining("操作未结束")});
      release();runView(await running);
      expect((await f.controller.request(query)).ok).toBe(false);expect(f.runtime.tasks[0]!.broker.signal.aborted).toBe(false);
      f.runtime.tasks[0]!.finish();await settle();expect((await f.controller.request(query)).ok).toBe(true);
    }finally{release?.();f.controller.dispose();}
  });
});

describe("R141 command and network diagnostics wiring",()=>{
  const network={request:async()=>"null",dispose(){}};
  const result:PluginCommandResult={exitCode:0,signal:null,timedOut:false,durationMs:1,stdout:"synthetic",stderr:"",stdoutBytes:9,stderrBytes:0,stdoutTruncated:false,stderrTruncated:false};
  const args='{"argv":["git","status"]}';
  const command=(executed:{value:number})=>vi.fn(async(input:PluginCommandInput,context:PluginCommandContext)=>{
    context.assertCurrent();const allowed=await context.authorize({argv:input.argv,cwd:".",timeoutMs:15000,reason:"synthetic",risk:"workspace_read"});
    context.assertCurrent();if(!allowed)throw new PluginCommandFault("capability-denied");executed.value++;return result;
  });
  it("uses the actual host gate callback and returns bounded command data",async()=>{
    const executed={value:0},run=command(executed),f=await fixture(["commands.run"],undefined,true,{network,command:run});try{
      const started=runView(await f.controller.request(f.input));const reply=await f.runtime.tasks[0]!.broker.call("commands.run",args);
      expect(reply.ok&&JSON.parse(reply.valueJson)).toEqual(result);expect(f.applyCalls()).toBe(1);expect(executed.value).toBe(1);
      expect(run.mock.calls[0]![1]).toMatchObject({workspaceRoot:f.workspace,protectedPaths:[f.profile]});
      expect(runView(await f.controller.request({kind:"status",runId:started.id})).logs[0]?.message).toContain("退出码：0");
    }finally{f.controller.dispose();}
  });
  it("refuses missing host admission, chat, readonly and plan before invoking the local command adapter",async()=>{
    const executed={value:0},run=command(executed),f=await fixture(["commands.run"],undefined,false,{network,command:run});try{
      expect((await f.controller.request({...f.input,scope:"chat"})).ok).toBe(false);
      runView(await f.controller.request(f.input));expect(await f.runtime.tasks[0]!.broker.call("commands.run",args)).toMatchObject({ok:false,code:"capability-denied"});
      f.runtime.tasks[0]!.finish();await settle();
      for(const patch of [{permissionMode:"read-only" as const},{permissionMode:"full-access" as const,planActive:true}]){
        f.change(patch);runView(await f.controller.request(f.input));const task=f.runtime.tasks.at(-1)!;
        expect(await task.broker.call("commands.run",args)).toMatchObject({ok:false,code:"capability-denied"});task.finish();await settle();
      }
      expect(run).not.toHaveBeenCalled();
    }finally{f.controller.dispose();}
  });
  it("never executes after denial or after owner change while confirmation is pending",async()=>{
    for(const revoked of [false,true]){
      let decide!:(allowed:boolean)=>void;const pending=new Promise<boolean>(resolve=>{decide=resolve}),executed={value:0},run=command(executed);
      const f=await fixture(["commands.run"],undefined,true,{network,command:run,authorize:()=>pending});try{
        runView(await f.controller.request(f.input));const call=f.runtime.tasks[0]!.broker.call("commands.run",args);
        await settle();expect(executed.value).toBe(0);if(revoked)f.change({revision:2});decide(revoked);
        expect(await call).toMatchObject({ok:false,code:revoked?"revoked":"capability-denied"});expect(executed.value).toBe(0);
      }finally{f.controller.dispose();}
    }
  });
  it("keeps a fixed host network diagnostic when the Guest leaves the rejection uncaught",async()=>{
    const f=await fixture(["network.request"],undefined,false,{network:{request:async()=>{throw new PluginNetworkFault("non-public-address");},dispose(){}}});try{
      const started=runView(await f.controller.request({...f.input,scope:"chat"})),task=f.runtime.tasks[0]!;
      expect(await task.broker.call("network.request",'{"url":"https://example.com/","method":"GET"}')).toMatchObject({ok:false,code:"capability-denied"});
      task.finish({ok:false,code:"guest-error"});await settle();const view=runView(await f.controller.request({kind:"status",runId:started.id}));
      expect(view.status).toBe("failed");expect(view.logs[0]).toMatchObject({level:"error"});expect(view.logs[0]?.message).toContain("公网");
      expect(JSON.stringify(view.logs)).not.toMatch(/example\.com|198\.18|stack|certificate/i);
    }finally{f.controller.dispose();}
  });
});

describe("installed plugin controller",()=>{
  it("exposes actual installed metadata and only currently implemented capabilities",async()=>{
    const f=await fixture();try{
      const listed=await f.controller.request({kind:"list"});expect(listed.ok).toBe(true);
      if(listed.ok){expect(listed.snapshot?.items[0]?.contentHash).toBe(f.item.contentHash);expect(listed.availableCapabilities).toContain("workspace.readText");expect(listed.availableCapabilities).toContain("commands.run");}
    }finally{f.controller.dispose();}
  });
  it("stages a proposal without editing a draft; reports one run with owner and revision",async()=>{
    const f=await fixture();try{
      const started=runView(await f.controller.request(f.input));
      expect(started).toMatchObject({status:"running",target:"current",draftRevision:7});
      const task=f.runtime.tasks[0]!;
      expect(await task.broker.call("draft.append",'{"text":"A suggestion"}')).toEqual({ok:true,valueJson:'{"staged":true}'});
      await task.broker.call("log",'{"level":"info","message":"done"}');
      task.finish();await settle();
      const view=runView(await f.controller.request({kind:"status",runId:started.id}));
      expect(view).toMatchObject({status:"completed",draftProposal:"A suggestion",logs:[{level:"info",message:"done"}]});
      await f.controller.request({kind:"list"});
      expect(runView(await f.controller.request({kind:"status",runId:started.id})).draftProposal).toBe("A suggestion");
    }finally{f.controller.dispose();}
  });
  it("uses the real safe reader and private storage without exposing another namespace",async()=>{
    const f=await fixture(["workspace.readText","storage.get","storage.set"]);try{
      await f.controller.request(f.input);const broker=f.runtime.tasks[0]!.broker;
      const read=await broker.call("workspace.readText",'{"path":"input.txt"}');
      expect(read.ok).toBe(true);if(read.ok)expect(read.valueJson).toContain("synthetic workspace text");
      await writeFile(join(f.workspace,".env"),"DO_NOT_READ=synthetic");
      expect((await broker.call("workspace.readText",'{"path":".env"}')).ok).toBe(false);
      expect((await broker.call("storage.set",'{"key":"count","value":1}')).ok).toBe(true);
      const stored=await broker.call("storage.get",'{"key":"count"}');expect(stored.ok).toBe(true);if(stored.ok)expect(JSON.parse(stored.valueJson)).toEqual(1);
    }finally{f.controller.dispose();}
  });
  it("denies uninstalled/stale package versions and missing permissions before starting",async()=>{
    const f=await fixture();try{
      expect((await f.controller.request({...f.input,contentHash:"f".repeat(64)})).ok).toBe(false);
      const s=await f.store.request({kind:"list"});if(!s.ok)throw Error();
      await f.store.request({kind:"grants",id:f.item.manifest.id,grants:[],revision:s.snapshot.revision});
      expect((await f.controller.request(f.input)).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(0);
    }finally{f.controller.dispose();}
  });
  it("denies unknown fields, invalid ownership, busy owners and malformed revision",async()=>{
    const f=await fixture();try{
      for(const input of [{...f.input,target:"other"},{...f.input,draftRevision:-1},{...f.input,inputJson:1},{...f.input,grant:true}])expect((await f.controller.request(input)).ok).toBe(false);
      f.change({busy:true});expect((await f.controller.request(f.input)).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(0);
    }finally{f.controller.dispose();}
  });
  it("does not start a previous owner after asynchronous package resolution",async()=>{
    const f=await fixture();try{
      let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});const original=f.store.resolve.bind(f.store);
      vi.spyOn(f.store,"resolve").mockImplementation(async(...args)=>{await gate;return original(...args)});
      const pending=f.controller.request(f.input);f.change({revision:3});release();
      expect((await pending).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(0);
    }finally{f.controller.dispose();}
  });
  it("reserves concurrency while installation reads are still pending",async()=>{
    const f=await fixture();try{
      let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});const original=f.store.resolve.bind(f.store);
      vi.spyOn(f.store,"resolve").mockImplementation(async(...args)=>{await gate;return original(...args)});
      const a=f.controller.request(f.input),b=f.controller.request(f.input);
      expect((await f.controller.request(f.input)).ok).toBe(false);release();
      expect((await a).ok).toBe(true);expect((await b).ok).toBe(true);expect(f.runtime.tasks).toHaveLength(2);
    }finally{f.controller.dispose();}
  });
  it("cancels running work when enabled/grants change and clears unfinished proposals",async()=>{
    const f=await fixture();try{
      const started=runView(await f.controller.request(f.input));
      await f.runtime.tasks[0]!.broker.call("draft.append",'{"text":"stale"}');
      const s=await f.store.request({kind:"list"});if(!s.ok)throw Error();
      await f.store.request({kind:"enable",id:f.item.manifest.id,enabled:false,revision:s.snapshot.revision});await settle();
      expect((await f.controller.request({kind:"status",runId:started.id})).ok).toBe(false);
      expect(f.runtime.tasks[0]!.broker.signal.aborted).toBe(true);
    }finally{f.controller.dispose();}
  });
  it("does not disclose output/logs to a changed owner; old cancellation remains possible",async()=>{
    const f=await fixture();try{
      const started=runView(await f.controller.request(f.input));
      await f.runtime.tasks[0]!.broker.call("log",'{"level":"info","message":"old owner"}');
      f.change({revision:3});const stale=await f.controller.request({kind:"status",runId:started.id});
      expect(stale.ok).toBe(false);expect(JSON.stringify(stale)).not.toContain("old owner");
      expect(await f.controller.request({kind:"cancel",runId:started.id})).toEqual({ok:true});
    }finally{f.controller.dispose();}
  });
  it("invalidates a completed preview when permissions change before insertion",async()=>{
    const f=await fixture();try{
      const started=runView(await f.controller.request(f.input));
      await f.runtime.tasks[0]!.broker.call("draft.append",'{"text":"old preview"}');
      f.runtime.tasks[0]!.finish();await settle();
      const snapshot=await f.store.request({kind:"list"});if(!snapshot.ok)throw Error();
      await f.store.request({kind:"grants",id:f.item.manifest.id,grants:[],revision:snapshot.snapshot.revision});
      const stale=await f.controller.request({kind:"status",runId:started.id});
      expect(stale.ok).toBe(false);expect(JSON.stringify(stale)).not.toContain("old preview");
    }finally{f.controller.dispose();}
  });
  it("bounds accumulated draft proposals and retains the explicit resource code",async()=>{
    const f=await fixture();try{
      await f.controller.request(f.input);const broker=f.runtime.tasks[0]!.broker;
      expect((await broker.call("draft.append",JSON.stringify({text:"a".repeat(20000)}))).ok).toBe(true);
      expect(await broker.call("draft.append",JSON.stringify({text:"b".repeat(20000)}))).toEqual({ok:false,code:"resource-limit"});
    }finally{f.controller.dispose();}
  });
  it("stops on dispose and refuses later calls",async()=>{
    const f=await fixture();const started=runView(await f.controller.request(f.input));f.controller.dispose();await settle();
    expect(f.runtime.tasks[0]!.broker.signal.aborted).toBe(true);expect((await f.controller.request({kind:"status",runId:started.id})).ok).toBe(false);
  });
});

describe("plugin network controller wiring",()=>{
  const requestJson='{"url":"https://example.com/resource","method":"GET"}';
  const fakeNetwork=()=>({request:vi.fn(async()=>'{"status":200,"ok":true,"contentType":"text/plain","body":"synthetic"}'),dispose:vi.fn()});
  it("advertises network but refuses a workspace request without its real host gate",async()=>{
    const network=fakeNetwork(),f=await fixture(["network.request"],undefined,false,{network});try{
      const listed=await f.controller.request({kind:"list"});expect(listed.ok&&listed.availableCapabilities).toContain("network.request");
      runView(await f.controller.request(f.input));
      expect(await f.runtime.tasks[0]!.broker.call("network.request",requestJson)).toMatchObject({ok:false,code:"capability-denied"});
      expect(network.request).not.toHaveBeenCalled();
    }finally{f.controller.dispose();expect(network.dispose).toHaveBeenCalledOnce();}
  });
  it("sends nothing while awaiting approval and nothing after denial",async()=>{
    let decide!:(allow:boolean)=>void;const pending=new Promise<boolean>(resolve=>{decide=resolve});
    const network=fakeNetwork(),f=await fixture(["network.request"],undefined,true,{network,authorize:()=>pending});try{
      runView(await f.controller.request(f.input));const call=f.runtime.tasks[0]!.broker.call("network.request",requestJson);
      await settle();expect(f.applyCalls()).toBe(1);expect(network.request).not.toHaveBeenCalled();
      decide(false);expect(await call).toMatchObject({ok:false,code:"capability-denied"});expect(network.request).not.toHaveBeenCalled();
    }finally{f.controller.dispose();}
  });
  it("rechecks the owner after permission returns before sending",async()=>{
    let decide!:(allow:boolean)=>void;const pending=new Promise<boolean>(resolve=>{decide=resolve});
    const network=fakeNetwork(),f=await fixture(["network.request"],undefined,true,{network,authorize:()=>pending});try{
      runView(await f.controller.request(f.input));const call=f.runtime.tasks[0]!.broker.call("network.request",requestJson);
      await settle();f.change({revision:2});decide(true);
      expect(await call).toMatchObject({ok:false,code:"revoked"});expect(network.request).not.toHaveBeenCalled();
    }finally{f.controller.dispose();}
  });
  it("passes an approved request through the lease, while independent chat needs only its explicit grant",async()=>{
    const network=fakeNetwork(),f=await fixture(["network.request"],undefined,true,{network});try{
      runView(await f.controller.request(f.input));expect((await f.runtime.tasks[0]!.broker.call("network.request",requestJson)).ok).toBe(true);expect(f.applyCalls()).toBe(1);
      f.runtime.tasks[0]!.finish();await settle();f.change({permissionMode:"read-only"});
      runView(await f.controller.request({...f.input,scope:"chat"}));const chat=f.runtime.tasks[1]!.broker;
      expect((await chat.call("network.request",requestJson)).ok).toBe(true);expect(f.applyCalls()).toBe(1);
      expect(await chat.call("network.request",'{"url":"https://other.example/","method":"GET"}')).toMatchObject({ok:false,code:"capability-denied"});
      expect(network.request).toHaveBeenCalledTimes(2);
    }finally{f.controller.dispose();}
  });
  it("cancels an in-flight transport and discards any late result",async()=>{
    let received:AbortSignal|undefined,finish!:(value:string)=>void;
    const network={request:vi.fn((_args:unknown,context:{signal:AbortSignal})=>{received=context.signal;return new Promise<string>(resolve=>{finish=resolve});}),dispose:vi.fn()};
    const f=await fixture(["network.request"],undefined,true,{network});try{
      const run=runView(await f.controller.request(f.input)),call=f.runtime.tasks[0]!.broker.call("network.request",requestJson);
      await vi.waitFor(()=>expect(received).toBeDefined());await f.controller.request({kind:"cancel",runId:run.id});
      expect(received?.aborted).toBe(true);finish('"late"');expect(await call).toMatchObject({ok:false});
    }finally{f.controller.dispose();}
  });
});

const uiActions: readonly ExecutablePluginAction[] = [
  {id:"run",title:"Inspect",scope:"both",export:"run",inputs:[],capabilities:["ui.present","ui.update"]},
  {id:"prepare",title:"Prepare note",scope:"both",export:"prepare",inputs:[{id:"text",type:"text",label:"Text",required:true,maxLength:100}],capabilities:["draft.append"]},
];
const definition = () => ({title:"Actual result",blocks:[{type:"text",text:"Synthetic result"}],actions:[{id:"note",label:"Prepare note",actionId:"prepare",inputJson:'{"text":"original"}'}]});
async function viewFixture(actions=uiActions){return fixture(["ui.present","ui.update","draft.append"],actions);}
async function presented(f:Awaited<ReturnType<typeof viewFixture>>,complete=true){
  const started=runView(await f.controller.request(f.input));
  const reply=await f.runtime.tasks[0]!.broker.call("ui.present",JSON.stringify({view:definition()}));
  if(!reply.ok)throw Error(reply.code);
  if(complete){f.runtime.tasks[0]!.finish();await settle();}
  const current=runView(await f.controller.request({kind:"status",runId:started.id}));
  if(!current.controlledView)throw Error("Expected controlled view");
  const follow={kind:"view-action" as const,runId:current.id,viewId:current.controlledView.id,viewRevision:current.controlledView.revision,buttonId:"note",inputJson:'{"text":"edited by user"}',draftRevision:7};
  return{current,follow};
}

describe("controlled plugin views",()=>{
  it("presents once and updates only the current view revision without exposing mutable state",async()=>{
    const f=await viewFixture();try{
      const {current}=await presented(f,false),broker=f.runtime.tasks[0]!.broker,initial=current.controlledView!;
      expect(initial.revision).toBe(1);expect(initial.id).toMatch(/^[0-9a-f-]{36}$/);
      const change={viewId:initial.id,revision:initial.revision,view:{...definition(),title:"Updated result"}};
      expect(await broker.call("ui.update",JSON.stringify(change))).toEqual({ok:true,valueJson:JSON.stringify({viewId:initial.id,revision:2})});
      expect(await broker.call("ui.update",JSON.stringify(change))).toEqual({ok:false,code:"invalid-input"});
      expect(await broker.call("ui.update",JSON.stringify({...change,viewId:"another",revision:2}))).toEqual({ok:false,code:"invalid-input"});
      expect(await broker.call("ui.present",JSON.stringify({view:definition()}))).toEqual({ok:false,code:"invalid-input"});
      const next=runView(await f.controller.request({kind:"status",runId:current.id}));
      expect(next.controlledView?.title).toBe("Updated result");
      (next.controlledView as {title:string}).title="tampered copy";
      expect(runView(await f.controller.request({kind:"status",runId:current.id})).controlledView?.title).toBe("Updated result");
    }finally{f.controller.dispose();}
  });
  it("rejects undeclared targets and invalid target parameters before publishing a view",async()=>{
    const f=await viewFixture();try{
      const run=runView(await f.controller.request(f.input)),broker=f.runtime.tasks[0]!.broker;
      for(const button of [{...definition().actions[0]!,actionId:"missing"},{...definition().actions[0]!,inputJson:'{"text":12}'},{...definition().actions[0]!,inputJson:'{"text":"fine","unknown":1}'}]){
        expect(await broker.call("ui.present",JSON.stringify({view:{...definition(),actions:[button]}}))).toEqual({ok:false,code:"invalid-input"});
      }
      expect(runView(await f.controller.request({kind:"status",runId:run.id})).controlledView).toBeUndefined();
    }finally{f.controller.dispose();}
  });
  it("does not use a chat view to invoke a workbench-only action",async()=>{
    const f=await viewFixture([uiActions[0]!,{...uiActions[1]!,scope:"workbench"}]);try{
      await f.controller.request({...f.input,scope:"chat"});
      expect(await f.runtime.tasks[0]!.broker.call("ui.present",JSON.stringify({view:definition()}))).toEqual({ok:false,code:"invalid-input"});
    }finally{f.controller.dispose();}
  });
  it("needs explicit follow-up with edited parameters and consumes the source only after starting",async()=>{
    const f=await viewFixture();try{
      const {current,follow}=await presented(f);expect(f.runtime.tasks).toHaveLength(1);
      const next=runView(await f.controller.request(follow));
      expect(next).toMatchObject({status:"running",scope:"workbench",target:"current",draftRevision:7});
      expect(f.runtime.tasks[1]!.request).toMatchObject({actionId:"prepare",inputJson:'{"text":"edited by user"}'});
      expect(runView(await f.controller.request({kind:"status",runId:current.id})).controlledView).toBeUndefined();
      expect((await f.controller.request(follow)).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(2);
    }finally{f.controller.dispose();}
  });
  it("refuses stale or spoofed button/view/draft tokens and extra identity fields",async()=>{
    const f=await viewFixture();try{
      const {follow}=await presented(f);
      for(const value of [{...follow,viewRevision:0},{...follow,viewRevision:2},{...follow,viewId:"wrong"},{...follow,runId:"other"},{...follow,buttonId:"missing"},{...follow,draftRevision:8},{...follow,inputJson:1},{...follow,pluginId:"other"}])expect((await f.controller.request(value)).ok).toBe(false);
      expect(f.runtime.tasks).toHaveLength(1);
    }finally{f.controller.dispose();}
  });
  it("does not launch from running, failed or cancelled results",async()=>{
    for(const ending of [{ok:false,code:"guest-error"} as const,{ok:false,code:"cancelled"} as const]){
      const f=await viewFixture();try{
        const {current,follow}=await presented(f,false);
        expect((await f.controller.request(follow)).ok).toBe(false);
        f.runtime.tasks[0]!.finish(ending);await settle();
        expect(runView(await f.controller.request({kind:"status",runId:current.id})).controlledView).toBeUndefined();
        expect((await f.controller.request(follow)).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(1);
      }finally{f.controller.dispose();}
    }
  });
  it("rejects invalid edited input without consuming the result",async()=>{
    const f=await viewFixture();try{
      const {current,follow}=await presented(f);
      expect((await f.controller.request({...follow,inputJson:'{"text":42}'})).ok).toBe(false);
      expect(runView(await f.controller.request({kind:"status",runId:current.id})).controlledView).toBeDefined();
      expect((await f.controller.request(follow)).ok).toBe(true);expect(f.runtime.tasks).toHaveLength(2);
    }finally{f.controller.dispose();}
  });
  it("rechecks child capabilities instead of treating a button as permission",async()=>{
    const f=await viewFixture();try{
      const snapshot=await f.store.request({kind:"list"});if(!snapshot.ok)throw Error();
      await f.store.request({kind:"grants",id:f.item.manifest.id,grants:["ui.present","ui.update"],revision:snapshot.snapshot.revision});
      const {follow}=await presented(f);
      expect((await f.controller.request(follow)).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(1);
    }finally{f.controller.dispose();}
  });
  it("does not start duplicate actions while the installed package is being resolved",async()=>{
    const f=await viewFixture();try{
      const {follow}=await presented(f);let release!:()=>void;
      const gate=new Promise<void>(resolve=>{release=resolve}),original=f.store.resolve.bind(f.store);
      vi.spyOn(f.store,"resolve").mockImplementation(async(...args)=>{await gate;return original(...args)});
      const first=f.controller.request(follow);
      expect((await f.controller.request(follow)).ok).toBe(false);release();
      expect((await first).ok).toBe(true);expect(f.runtime.tasks).toHaveLength(2);
    }finally{f.controller.dispose();}
  });
  it("revalidates source ownership after asynchronous launch work",async()=>{
    const f=await viewFixture();try{
      const {follow}=await presented(f);let release!:()=>void;
      const gate=new Promise<void>(resolve=>{release=resolve}),original=f.store.resolve.bind(f.store);
      vi.spyOn(f.store,"resolve").mockImplementation(async(...args)=>{await gate;return original(...args)});
      const pending=f.controller.request(follow);f.change({revision:3});release();
      expect((await pending).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(1);
    }finally{f.controller.dispose();}
  });
  it("invalidates completed views after permission or installation changes",async()=>{
    const f=await viewFixture();try{
      const {current,follow}=await presented(f),snapshot=await f.store.request({kind:"list"});if(!snapshot.ok)throw Error();
      await f.store.request({kind:"enable",id:f.item.manifest.id,enabled:false,revision:snapshot.snapshot.revision});
      expect((await f.controller.request(follow)).ok).toBe(false);
      expect((await f.controller.request({kind:"status",runId:current.id})).ok).toBe(false);expect(f.runtime.tasks).toHaveLength(1);
    }finally{f.controller.dispose();}
  });
  it("retains the source result when the child cannot start",async()=>{
    const f=await viewFixture();try{
      const {current,follow}=await presented(f);
      vi.spyOn(f.runtime,"start").mockImplementationOnce(()=>{throw Error("synthetic startup failure")});
      expect((await f.controller.request(follow)).ok).toBe(false);
      expect(runView(await f.controller.request({kind:"status",runId:current.id})).controlledView).toBeDefined();
      expect((await f.controller.request(follow)).ok).toBe(true);
    }finally{f.controller.dispose();}
  });
  it("also retains a source when start returns an immediate failed task instead of throwing",async()=>{
    const f=await viewFixture();try{
      const {current,follow}=await presented(f);
      vi.spyOn(f.runtime,"start").mockImplementationOnce((_request,broker)=>{
        broker.dispose();return {id:"unavailable",accepted:false,result:Promise.resolve({ok:false,code:"runner-unavailable"} as const),closed:Promise.resolve(),cancel(){}};
      });
      const rejected=await f.controller.request(follow);
      expect(rejected.ok).toBe(false);expect(JSON.stringify(rejected)).toContain("原结果已保留");
      expect(runView(await f.controller.request({kind:"status",runId:current.id})).controlledView).toBeDefined();
      expect((await f.controller.request(follow)).ok).toBe(true);expect(f.runtime.tasks).toHaveLength(2);
    }finally{f.controller.dispose();}
  });
});

describe("durable plugin output wiring",()=>{
  it("creates a real artifact, retains its receipt after Guest failure, and reads it after disable",async()=>{
    const f=await fixture(["artifacts.create"]);try{
      const started=runView(await f.controller.request({...f.input,scope:"chat"}));
      const made=await f.runtime.tasks[0]!.broker.call("artifacts.create",JSON.stringify({name:"summary.md",mime:"text/markdown",text:"# 合成文件\n"}));
      expect(made.ok).toBe(true);if(!made.ok)throw Error();
      const created=JSON.parse(made.valueJson);expect(created).toMatchObject({name:"summary.md",saved:true});expect(created).not.toHaveProperty("path");
      f.runtime.tasks[0]!.finish({ok:false,code:"guest-error"});await settle();
      const finished=runView(await f.controller.request({kind:"status",runId:started.id}));
      expect(finished.status).toBe("failed");expect(finished.artifacts?.[0]?.id).toBe(created.artifactId);
      const snapshot=await f.store.request({kind:"list"});if(!snapshot.ok)throw Error();
      await f.store.request({kind:"enable",id:f.item.manifest.id,enabled:false,revision:snapshot.snapshot.revision});
      const listed=await f.controller.request({kind:"outputs-list",scope:"chat",target:"current"});
      expect(listed.ok&&listed.outputs?.artifacts[0]?.id).toBe(created.artifactId);
      const read=await f.controller.request({kind:"artifact-read",scope:"chat",target:"current",id:created.artifactId});
      expect(read.ok&&read.content).toBe("# 合成文件\n");
      expect((await f.controller.request({kind:"artifact-read",scope:"chat",target:"other",id:created.artifactId})).ok).toBe(false);
    }finally{f.controller.dispose();}
  });
  it("stages a real checked diff without changing the file, then explicitly applies through the host lease",async()=>{
    const f=await fixture(["workspace.readText","workspace.proposePatch"],undefined,true);try{
      const started=runView(await f.controller.request(f.input)),broker=f.runtime.tasks[0]!.broker;
      const read=await broker.call("workspace.readText",'{"path":"input.txt"}');if(!read.ok)throw Error();
      const original=JSON.parse(read.valueJson);expect(original.sha256).toBe(createHash("sha256").update("synthetic workspace text").digest("hex"));
      const made=await broker.call("workspace.proposePatch",JSON.stringify({path:"input.txt",baseHash:original.sha256,content:"reviewed change\n"}));
      expect(made.ok).toBe(true);if(!made.ok)throw Error();const proposal=JSON.parse(made.valueJson);
      expect(proposal.status).toBe("pending");expect(await readFile(join(f.workspace,"input.txt"),"utf8")).toBe("synthetic workspace text");
      f.runtime.tasks[0]!.finish();await settle();
      expect(runView(await f.controller.request({kind:"status",runId:started.id})).proposals?.[0]?.id).toBe(proposal.proposalId);
      expect(await f.controller.request({kind:"patch-apply",scope:"workbench",target:"current",id:proposal.proposalId})).toMatchObject({ok:true,applying:true});
      await vi.waitFor(async()=>{
        const result=await f.controller.request({kind:"patch-read",scope:"workbench",target:"current",id:proposal.proposalId});
        expect(result.ok&&result.patch?.proposal.status).toBe("applied");
      });
      expect(await readFile(join(f.workspace,"input.txt"),"utf8")).toBe("reviewed change\n");
      // A committed receipt can be visible while the original job still cleans
      // its owned temporary file. Duplicate requests then acknowledge that same
      // job; after it settles the terminal proposal must refuse a new apply.
      await vi.waitFor(async()=>expect((await f.controller.request({kind:"patch-apply",scope:"workbench",target:"current",id:proposal.proposalId})).ok).toBe(false));
      expect(f.applyCalls()).toBe(1);
    }finally{f.controller.dispose();}
  });
  it("keeps a saved proposal after later Guest failure and rejects applying under readonly mode",async()=>{
    const f=await fixture(["workspace.proposePatch"],undefined,true);try{
      const started=runView(await f.controller.request(f.input));
      const made=await f.runtime.tasks[0]!.broker.call("workspace.proposePatch",'{"path":"new.txt","baseHash":null,"content":"draft only"}');
      expect(made.ok).toBe(true);if(!made.ok)throw Error();const proposal=JSON.parse(made.valueJson);
      f.runtime.tasks[0]!.finish({ok:false,code:"guest-error"});await settle();
      expect(runView(await f.controller.request({kind:"status",runId:started.id})).proposals).toHaveLength(1);
      f.change({permissionMode:"read-only",permissionRevision:2});
      const list=await f.controller.request({kind:"outputs-list",scope:"workbench",target:"current"});
      expect(list.ok&&list.outputs?.proposals[0]?.status).toBe("pending");
      expect((await f.controller.request({kind:"patch-apply",scope:"workbench",target:"current",id:proposal.proposalId})).ok).toBe(false);
      await expect(readFile(join(f.workspace,"new.txt"))).rejects.toMatchObject({code:"ENOENT"});
    }finally{f.controller.dispose();}
  });
});
