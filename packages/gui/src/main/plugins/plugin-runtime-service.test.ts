import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExecutablePluginPackage } from "../../shared/executable-plugins.js";
import type { PluginUtilityInput } from "../../shared/plugin-runtime.js";
import { PluginCapabilityBroker, type PluginBrokerPolicy } from "./capability-broker.js";
import { executablePluginPackageHash, PluginRuntimeService, type PluginProcess } from "./plugin-runtime-service.js";

class Child extends EventEmitter implements PluginProcess {
  sent: PluginUtilityInput[]=[];
  killed=0;
  postMessage(message:PluginUtilityInput){this.sent.push(message);}
  kill(){this.killed++;return true;}
  message(raw:unknown){this.emit("message",raw);}
}
function fixture() {
  const pkg=parseExecutablePluginPackage(JSON.stringify({manifest:{schemaVersion:2,apiVersion:1,id:"sample.plugin",name:"Sample",version:"1.0.0",description:"",entry:"main.js",capabilities:[{name:"storage.get"}],actions:[{id:"run",title:"Run",scope:"both",export:"run",inputs:[],capabilities:["storage.get"]}]},files:[{path:"main.js",source:"export function run(){return 42}"}]}));
  const binding={pluginId:pkg.manifest.id,contentHash:executablePluginPackageHash(pkg),grantRevision:1,sessionId:"synthetic",sessionRevision:1,permissionRevision:1,scope:"chat" as const,actionId:"run"};
  let policy:PluginBrokerPolicy={...binding,enabled:true,permissionMode:"read-only",planActive:false,grantedCapabilities:pkg.manifest.capabilities};
  const children:Child[]=[];
  const read=vi.fn(()=>'{"value":42}');
  const broker=()=>new PluginCapabilityBroker({manifest:pkg.manifest,binding,current:()=>policy,handlers:{"storage.get":read}});
  const service=new PluginRuntimeService({createProcess:()=>{const child=new Child();children.push(child);return child;},deadlines:{startupMs:50,wallMs:500,busyMs:30,pollMs:10}});
  const request={packageJson:JSON.stringify(pkg),actionId:"run",inputJson:"{}"};
  return {pkg,binding,broker,service,request,children,read,change:(change:Partial<PluginBrokerPolicy>)=>{policy={...policy,...change};}};
}
afterEach(()=>vi.useRealTimers());

describe("plugin per-run lifecycle",()=>{
  it("R145 closed resolves on the owned process exit without disposing another active run",async()=>{
    const f=fixture(),first=f.service.start(f.request,f.broker()),second=f.service.start(f.request,f.broker());
    let closed=false;void first.closed.then(()=>{closed=true;});
    f.children[0]!.message({kind:"ready"});f.children[0]!.message({kind:"result",result:{ok:true,valueJson:"42"}});
    expect(await first.result).toEqual({ok:true,valueJson:"42"});await Promise.resolve();expect(closed).toBe(false);
    expect(f.children[1]!.killed).toBe(0);f.children[0]!.emit("exit",0);await first.closed;expect(closed).toBe(true);
    second.cancel();expect(await second.result).toEqual({ok:false,code:"cancelled"});
    f.children[1]!.emit("exit",0);await second.closed;expect(f.service.activeCount).toBe(0);
    const rejected=f.service.start({...f.request,inputJson:'{"unknown":true}'},f.broker());
    expect(rejected.accepted).toBe(false);await rejected.closed;expect(f.children).toHaveLength(2);f.service.dispose();
  });
  it("runs once and holds the process slot until exit, even after returning a result",async()=>{
    const f=fixture(),task=f.service.start(f.request,f.broker()),child=f.children[0]!;
    expect(task.accepted).toBe(true);
    expect(child.sent[0]?.kind).toBe("start");
    child.message({kind:"ready"});child.message({kind:"result",result:{ok:true,valueJson:'42'}});
    expect(await task.result).toEqual({ok:true,valueJson:'42'});
    expect(child.killed).toBe(1);expect(f.service.activeCount).toBe(1);
    child.message({kind:"result",result:{ok:true,valueJson:'99'}});
    child.emit("exit",0);expect(f.service.activeCount).toBe(0);
  });
  it("does not start mismatched content, inputs or stale grants",async()=>{
    const f=fixture();
    expect(await f.service.start({...f.request,packageJson:f.request.packageJson.replace('return 42','return 99')},f.broker()).result).toEqual({ok:false,code:"revoked"});
    expect(await f.service.start({...f.request,inputJson:'{"unknown":1}'},f.broker()).result).toEqual({ok:false,code:"invalid-input"});
    f.change({enabled:false});
    expect(await f.service.start(f.request,f.broker()).result).toEqual({ok:false,code:"revoked"});
    expect(f.children).toHaveLength(0);
  });
  it("bounds active processes and does not free a slot for a failed kill",async()=>{
    const f=fixture(),a=f.service.start(f.request,f.broker()),b=f.service.start(f.request,f.broker());
    f.children[0]!.kill=()=>false;a.cancel();
    expect(await a.result).toEqual({ok:false,code:"cancelled"});
    const rejected=f.service.start(f.request,f.broker());
    expect(rejected.accepted).toBe(false);
    expect(await rejected.result).toEqual({ok:false,code:"busy"});
    f.children[0]!.emit("exit",1);
    const c=f.service.start(f.request,f.broker());expect(f.children).toHaveLength(3);
    b.cancel();c.cancel();f.children.forEach(x=>x.emit("exit",0));
  });
  it("binds the broker manifest as well as its content hash claim",async()=>{
    const f=fixture();
    const other=parseExecutablePluginPackage(JSON.stringify({...f.pkg,manifest:{...f.pkg.manifest,description:"stale manifest"}}));
    const broker=new PluginCapabilityBroker({manifest:other.manifest,binding:f.binding,current:()=>({...f.binding,enabled:true,permissionMode:"read-only",planActive:false,grantedCapabilities:other.manifest.capabilities}),handlers:{"storage.get":f.read}});
    expect(await f.service.start(f.request,broker).result).toEqual({ok:false,code:"revoked"});
    expect(f.children).toHaveLength(0);
  });
  it("rejects duplicate request IDs without invoking a handler twice",async()=>{
    const f=fixture(),task=f.service.start(f.request,f.broker()),child=f.children[0]!;
    child.message({kind:"ready"});
    const request={kind:"request",id:1,capability:"storage.get",argsJson:'{"key":"value"}'};
    child.message(request);child.message(request);
    expect(await task.result).toEqual({ok:false,code:"invalid-message"});
    expect(f.read).toHaveBeenCalledTimes(1);child.emit("exit",0);
  });
  it("cancels a pending handler and ignores all late results",async()=>{
    const f=fixture();let complete!:(json:string)=>void;
    f.read.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}) as any);
    const broker=f.broker(),task=f.service.start(f.request,broker),child=f.children[0]!;
    child.message({kind:"ready"});child.message({kind:"request",id:1,capability:"storage.get",argsJson:'{"key":"value"}'});
    task.cancel();complete('42');await Promise.resolve();await Promise.resolve();
    expect(await task.result).toEqual({ok:false,code:"cancelled"});
    expect(broker.signal.aborted).toBe(true);expect(child.sent.filter(x=>x.kind==="reply")).toHaveLength(0);child.emit("exit",0);
  });
  it("polls idle runs for a new session or permission revision",async()=>{
    vi.useFakeTimers();const f=fixture(),task=f.service.start(f.request,f.broker()),child=f.children[0]!;
    child.message({kind:"ready"});f.change({sessionRevision:2});await vi.advanceTimersByTimeAsync(11);
    expect(await task.result).toEqual({ok:false,code:"revoked"});expect(child.killed).toBe(1);child.emit("exit",0);
  });
  it("checks current policy again on final output before the poll",async()=>{
    const f=fixture(),task=f.service.start(f.request,f.broker()),child=f.children[0]!;
    child.message({kind:"ready"});f.change({contentHash:"changed"});child.message({kind:"result",result:{ok:true,valueJson:'42'}});
    expect(await task.result).toEqual({ok:false,code:"revoked"});child.emit("exit",0);
  });
  it("bounds startup, waiting and each uninterrupted busy slice",async()=>{
    vi.useFakeTimers();
    for(const mode of ["startup","wait","busy"]){
      const f=fixture(),task=f.service.start(f.request,f.broker()),child=f.children[0]!;
      if(mode!=="startup")child.message({kind:"ready"});
      if(mode==="busy"){child.message({kind:"phase",busy:true});await vi.advanceTimersByTimeAsync(20);child.message({kind:"phase",busy:true});}
      await vi.advanceTimersByTimeAsync(mode==="wait"?501:51);
      expect(await task.result).toEqual({ok:false,code:mode==="busy"?"resource-limit":"timeout"});child.emit("exit",0);
    }
  });
  it("reports early resource failure and process exit without retrying",async()=>{
    const f=fixture(),a=f.service.start(f.request,f.broker());
    f.children[0]!.message({kind:"result",result:{ok:false,code:"runner-unavailable"}});
    expect(await a.result).toEqual({ok:false,code:"runner-unavailable"});f.children[0]!.emit("exit",1);
    const b=f.service.start(f.request,f.broker());f.children[1]!.emit("exit",9);
    expect(await b.result).toEqual({ok:false,code:"runner-crashed"});expect(f.children).toHaveLength(2);
  });
  it("does not accept an action when creating its process throws",async()=>{
    const f=fixture(),broker=f.broker();
    const service=new PluginRuntimeService({createProcess:()=>{throw new Error("fixture factory failure");}});
    const task=service.start(f.request,broker);
    expect(task.accepted).toBe(false);
    expect(await task.result).toEqual({ok:false,code:"runner-unavailable"});
    expect(service.activeCount).toBe(0);expect(broker.signal.aborted).toBe(true);
  });
  it("does not accept a failed start post and holds its slot until actual exit",async()=>{
    const f=fixture(),child=new Child(),broker=f.broker();
    child.postMessage=()=>{throw new Error("fixture post failure");};
    const service=new PluginRuntimeService({createProcess:()=>child});
    const task=service.start(f.request,broker);
    expect(task.accepted).toBe(false);
    expect(await task.result).toEqual({ok:false,code:"runner-unavailable"});
    expect(child.killed).toBe(1);expect(service.activeCount).toBe(1);expect(broker.signal.aborted).toBe(true);
    child.emit("exit",1);expect(service.activeCount).toBe(0);
  });
  it("snapshots a synchronous termination during a successful post as not accepted",async()=>{
    const f=fixture(),child=new Child();
    child.postMessage=message=>{child.sent.push(message);child.message({kind:"result",result:{ok:false,code:"runner-unavailable"}});};
    const service=new PluginRuntimeService({createProcess:()=>child});
    const task=service.start(f.request,f.broker());
    expect(child.sent[0]?.kind).toBe("start");expect(task.accepted).toBe(false);
    expect(await task.result).toEqual({ok:false,code:"runner-unavailable"});
    expect(service.activeCount).toBe(1);child.emit("exit",1);expect(service.activeCount).toBe(0);
  });
  it("keeps an accepted start accepted after asynchronous startup failure",async()=>{
    vi.useFakeTimers();const f=fixture(),task=f.service.start(f.request,f.broker());
    expect(task.accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    expect(await task.result).toEqual({ok:false,code:"timeout"});expect(task.accepted).toBe(true);
    expect(f.children).toHaveLength(1);f.children[0]!.emit("exit",1);
  });
  it.each([null,{kind:"ready",unexpected:1},{kind:"result",result:{ok:true,valueJson:'42'}},{kind:"request",id:1,capability:"storage.get",argsJson:'{}'}])("denies malformed or premature messages",async message=>{
    const f=fixture(),task=f.service.start(f.request,f.broker());f.children[0]!.message(message);
    expect(await task.result).toEqual({ok:false,code:"invalid-message"});f.children[0]!.emit("exit",0);
  });
  it("disposes all active runs and refuses new work",async()=>{
    const f=fixture(),task=f.service.start(f.request,f.broker());f.service.dispose();
    expect(await task.result).toEqual({ok:false,code:"cancelled"});f.children[0]!.emit("exit",0);
    const rejected=f.service.start(f.request,f.broker());
    expect(rejected.accepted).toBe(false);
    expect(await rejected.result).toEqual({ok:false,code:"runner-unavailable"});
  });
});
