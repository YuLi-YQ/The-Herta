import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { EXECUTABLE_PLUGIN_CAPABILITY_NAMES, parseExecutablePluginPackage, type ExecutablePluginCapabilityName } from "../../shared/executable-plugins.js";
import type { PluginRunRequest, PluginRunResult } from "../../shared/plugin-runtime.js";
import type { PluginTrialFrozen } from "../../shared/plugin-trial.js";
import { PluginCapabilityBroker } from "./capability-broker.js";
import { executablePluginPackageHash, type PluginTask } from "./plugin-runtime-service.js";
import { runPluginGuest } from "./quickjs-runtime.js";
import { createPluginTrialService, PLUGIN_TRIAL_LIMITS } from "./plugin-trial-service.js";

const require = createRequire(import.meta.url);
const wasmBinary = Uint8Array.from(readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"))).buffer;
function frozen(source: string, names: readonly ExecutablePluginCapabilityName[] = EXECUTABLE_PLUGIN_CAPABILITY_NAMES): PluginTrialFrozen {
  const pkg = parseExecutablePluginPackage(JSON.stringify({ manifest: { schemaVersion: 2, apiVersion: 1, id: "example.trial", name: "Synthetic trial", version: "1.0.0",
    description: "Memory fixtures only", entry: "main.js", capabilities: names.map(name => name === "network.request" ? { name, origins: ["https://fixture.invalid"], methods: ["GET"] } : { name }),
    actions: [{ id: "run", title: "Run", scope: "workbench", export: "run", inputs: [], capabilities: names }] }, files: [{ path: "main.js", source }] }));
  const packageJson = JSON.stringify(pkg);
  return { candidateId: "fixture-candidate", revision: 1, sourceHash: createHash("sha256").update(packageJson).digest("hex"), contentHash: executablePluginPackageHash(pkg), packageJson };
}
function guard() { return { signal: new AbortController().signal, assertCurrent() {} }; }
function realGuestRuntime() {
  let count = 0;
  return { start: vi.fn((request: PluginRunRequest, broker: PluginCapabilityBroker): PluginTask => {
    const result = runPluginGuest({ ...request, wasmBinary }, { signal: broker.signal, onReady() {}, onPhase() {}, request: call => broker.call(call.capability, call.argsJson) });
    return { id: String(++count), accepted: true, result, closed: result.then(() => undefined), cancel() { broker.dispose(); } };
  }) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const request = { actionId: "run", scope: "workbench" as const, inputJson: "{}" };

describe("R145 isolated memory trial", () => {
  it("R145 trial executes all twelve capabilities with real QuickJS and explicit external samples", async () => {
    const runtime = realGuestRuntime(), service = createPluginTrialService({ runtime });
    const candidate = frozen(`export async function run(input,api){
      const original=await api.workspace.readText({path:'fixture.txt'});
      const proposal=await api.workspace.proposePatch({path:'fixture.txt',baseHash:original.sha256,content:'changed'});
      await api.storage.set({key:'count',value:2}); const count=await api.storage.get({key:'count'});
      const artifact=await api.artifacts.create({name:'trial.txt',mime:'text/plain',text:'synthetic artifact'});
      const command=await api.commands.run({argv:['fixture','--check']});
      const network=await api.network.request({url:'https://fixture.invalid/data',method:'GET'});
      await api.draft.append({text:'synthetic draft'});
      const view=await api.ui.present({view:{title:'Trial',blocks:[{type:'text',text:'First'}],actions:[]}});
      await api.ui.update({viewId:view.viewId,revision:view.revision,view:{title:'Trial',blocks:[{type:'status',tone:'success',text:'Second'}],actions:[]}});
      await api.log({level:'info',message:'Synthetic log'}); await api.progress({message:'Simulated',value:1});
      return {count,proposal,artifact,command,network,original};
    }`);
    const task = service.start(candidate, { ...request, fixturesJson: JSON.stringify({ workspace: [{ path: "fixture.txt", text: "\uFEFForiginal" }], privateValues: { count: 1 },
      commands: [{ argv: ["fixture", "--check"], result: { exitCode: 0, stdout: "explicit command sample", stderr: "" } }],
      network: [{ url: "https://fixture.invalid/data", method: "GET", response: { status: 200, contentType: "text/plain", body: "explicit network sample" } }] }) }, guard());
    const result = await task.result; await task.closed; service.dispose();
    expect(result.outcome).toBe("completed"); expect(result.runtimeResult.ok).toBe(true);
    const value = result.runtimeResult.ok ? JSON.parse(result.runtimeResult.valueJson) : null;
    expect(value.count).toBe(2); expect(value.original.text).toBe("original");
    expect(value.command.stdout).toBe("explicit command sample"); expect(value.network.body).toBe("explicit network sample");
    expect(new Set(result.trace.map(item => item.capability))).toEqual(new Set(EXECUTABLE_PLUGIN_CAPABILITY_NAMES));
    expect(result.trace.every(item => item.state === "completed" && item.simulated)).toBe(true);
    expect(result).toMatchObject({ simulated: true, externalEnvironmentVerified: false, candidateId: candidate.candidateId, revision: 1, contentHash: candidate.contentHash,
      draftProposal: "synthetic draft", controlledView: { revision: 2 }, progress: { value: 1 } });
    expect(result.proposals[0]).toMatchObject({ before: "\uFEFForiginal", after: "\uFEFFchanged", status: "pending" });
    expect(result.artifacts).toHaveLength(1); expect(result.logs).toHaveLength(1); expect(result.retainedBytes).toBeLessThan(PLUGIN_TRIAL_LIMITS.retainedBytes);
  });

  it("R145 trial records pre-handler rejections and marks absent network or command fixtures unverified", async () => {
    const service = createPluginTrialService({ runtime: realGuestRuntime() });
    const task = service.start(frozen(`export async function run(input,api){const result=[];
      for(const operation of [()=>api.network.request({url:'https://fixture.invalid/data',method:'GET'}),()=>api.commands.run({argv:['never-start']}),
        ()=>api.network.request({url:'https://outside.invalid/never-read',method:'GET'}),()=>api.network.request({url:'http://fixture.invalid/',method:'GET'})]){
        try{await operation();result.push('unexpected-success');}catch(e){result.push(String(e));}}
      return result;
    }`, ["network.request", "commands.run"]), request, guard());
    const result = await task.result; await task.closed; service.dispose();
    expect(result.outcome).toBe("unverified"); expect(result.unverified.map(item => item.capability).sort()).toEqual(["commands.run", "network.request"]);
    expect(result.trace.map(item => item.code)).toEqual(["capability-denied", "capability-denied", "capability-denied", "invalid-input"]);
    expect(result.trace.every(item => item.state === "rejected")).toBe(true);
    expect(JSON.stringify(result.trace)).not.toMatch(/fixture\.invalid|never-start|never-read/);
    expect(result.artifacts).toEqual([]); expect(result.proposals).toEqual([]);
  });

  it("R145 trial rejects changed candidate bytes before admission and bounds cumulative fixture responses", async () => {
    const runtime = realGuestRuntime(), service = createPluginTrialService({ runtime });
    const candidate = frozen(`export async function run(input,api){let accepted=0;const text='x'.repeat(32000);
      for(let i=0;i<60;i++){try{await api.storage.set({key:'value',value:text});accepted++;}catch(e){return{accepted,code:String(e)};}}return{accepted};
    }`, ["storage.set"]);
    expect(() => service.start({ ...candidate, packageJson: candidate.packageJson + " " }, request, guard())).toThrow("待检插件内容");
    expect(() => service.start(candidate, { ...request, inputJson: '{"unexpected":1}' }, guard())).toThrow("试跑参数");
    const duplicate = { argv: ["fixture"], result: { exitCode: 0, stdout: "synthetic", stderr: "" } };
    expect(() => service.start(candidate, { ...request, fixturesJson: JSON.stringify({ commands: [duplicate, duplicate] }) }, guard())).toThrow("试跑参数");
    expect(runtime.start).not.toHaveBeenCalled();
    const task = service.start(candidate, request, guard()), result = await task.result; await task.closed; service.dispose();
    expect(result.runtimeResult.ok).toBe(true);
    const value = result.runtimeResult.ok ? JSON.parse(result.runtimeResult.valueJson) : null;
    expect(value.code).toBe("resource-limit"); expect(value.accepted).toBeGreaterThan(0); expect(value.accepted).toBeLessThan(60);
    expect(result.trace.at(-1)?.code).toBe("resource-limit"); expect(result.retainedBytes).toBeLessThanOrEqual(PLUGIN_TRIAL_LIMITS.retainedBytes);
  });

  it("R145 trial binds final results to the candidate guard and cancels only its own shared-runtime tasks", async () => {
    const pending: { result: ReturnType<typeof deferred<PluginRunResult>>; closed: ReturnType<typeof deferred<void>>; cancel: ReturnType<typeof vi.fn> }[] = [];
    const runtime = { dispose: vi.fn(), start: vi.fn((_request: PluginRunRequest, _broker: PluginCapabilityBroker): PluginTask => {
      const result = deferred<PluginRunResult>(), closed = deferred<void>(), cancel = vi.fn(() => result.resolve({ ok: false, code: "cancelled" }));
      pending.push({ result, closed, cancel }); return { id: String(pending.length), accepted: true, result: result.promise, closed: closed.promise, cancel };
    }) };
    let current = true;
    const selected = { ...guard(), assertCurrent() { if (!current) throw Error("changed candidate"); } }, candidate = frozen("export function run(){return 42;}", []);
    const service = createPluginTrialService({ runtime }), task = service.start(candidate, request, selected);
    current = false; pending[0]!.result.resolve({ ok: true, valueJson: "42" });
    expect((await task.result).outcome).toBe("cancelled");
    current = true; expect(() => service.start(candidate, request, selected)).toThrow("已有试跑未结束");
    task.cancel(); expect(pending[0]!.cancel).toHaveBeenCalledOnce();
    pending[0]!.closed.resolve(); await task.closed; await Promise.resolve();
    const second = service.start(candidate, request, selected); service.dispose();
    expect(pending[1]!.cancel).toHaveBeenCalledOnce(); expect(runtime.dispose).not.toHaveBeenCalled();
    expect((await second.result).outcome).toBe("cancelled"); pending[1]!.closed.resolve(); await second.closed;
  });
});
