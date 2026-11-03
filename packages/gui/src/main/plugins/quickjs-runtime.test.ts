import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { QuickJSContext } from "quickjs-emscripten-core";
import { describe, expect, it, vi } from "vitest";
import type { ExecutablePluginCapabilityName } from "../../shared/executable-plugins.js";
import { PLUGIN_RUNTIME_LIMITS, type PluginCapabilityRequest, type PluginRunResult } from "../../shared/plugin-runtime.js";
import { runPluginGuest, type PluginGuestBridge, type PluginGuestRequest } from "./quickjs-runtime.js";

const require = createRequire(import.meta.url);
const wasmBinary = Uint8Array.from(readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"))).buffer;
function packageJson(source: string, capabilities: ExecutablePluginCapabilityName[] = [], additional: Record<string, string> = {}): string {
  return JSON.stringify({
    manifest: {
      schemaVersion: 2, apiVersion: 1, id: "example.runtime", name: "运行夹具", version: "1.0.0", description: "合成数据测试", entry: "src/main.js",
      capabilities: capabilities.map((name) => name === "network.request" ? { name, origins: ["https://example.invalid"], methods: ["GET"] } : { name }),
      actions: [{ id: "run", title: "运行", scope: "workbench", export: "run", inputs: [], capabilities }],
    },
    files: [{ path: "src/main.js", source }, ...Object.entries(additional).map(([path, source]) => ({ path, source }))],
  });
}
function requestFor(source: string, capabilities: ExecutablePluginCapabilityName[] = [], additional: Record<string, string> = {}): PluginGuestRequest {
  return { packageJson: packageJson(source, capabilities, additional), actionId: "run", inputJson: "{}", wasmBinary };
}
function bridge(overrides: Partial<PluginGuestBridge> = {}) {
  const controller = new AbortController();
  const events: string[] = [];
  const value: PluginGuestBridge = {
    signal: controller.signal,
    onReady: () => { events.push("ready"); },
    onPhase: (busy) => { events.push(busy ? "busy" : "idle"); },
    request: vi.fn(async (request: PluginCapabilityRequest): Promise<PluginRunResult> => ({ ok: true, valueJson: request.argsJson })),
    ...overrides,
  };
  return { controller, events, value };
}
async function execute(source: string, capabilities: ExecutablePluginCapabilityName[] = [], overrides: Partial<PluginGuestBridge> = {}) {
  const host = bridge(overrides);
  const result = await runPluginGuest(requestFor(source, capabilities), host.value);
  return { ...host, result };
}
function decoded(result: PluginRunResult): unknown {
  expect(result.ok).toBe(true);
  return result.ok ? JSON.parse(result.valueJson) : undefined;
}

describe("QuickJS ordinary JavaScript module runtime", () => {
  it("loads a real ES module, looks up its export and awaits the result", async () => {
    const { result, events } = await execute("export async function run() { return { value: await Promise.resolve(42), text: '黑塔 🌌' }; }");
    expect(decoded(result)).toEqual({ value: 42, text: "黑塔 🌌" });
    expect(events[0]).toBe("ready");
    expect(events).toContain("busy"); expect(events.at(-1)).toBe("idle");
  });

  it("supports frozen package-relative nested/static/dynamic imports without loading host modules", async () => {
    const req = requestFor("import { add } from './nested/math.mjs'; export async function run() { const { extra } = await import('../extra.js'); return add(20, extra); }", [], {
      "src/nested/math.mjs": "export const add = (a, b) => a + b;", "extra.js": "export const extra = 22;",
    });
    expect(decoded(await runPluginGuest(req, bridge().value))).toBe(42);
  });

  it("supports top-level await in an entry module", async () => {
    const { result } = await execute("const value = await Promise.resolve(42); export function run() { return value; }");
    expect(decoded(result)).toBe(42);
  });

  it("validates and supplies typed input/defaults before invoking Guest code", async () => {
    const req = requestFor("export function run(input) { return input; }");
    const parsed = JSON.parse(req.packageJson);
    parsed.manifest.actions[0].inputs = [
      { id: "name", label: "名称", type: "text", required: true, maxLength: 10 },
      { id: "count", label: "数量", type: "number", required: false, min: 0, max: 10, integer: true, default: 0 },
    ];
    req.packageJson = JSON.stringify(parsed); req.inputJson = '{"name":"星空"}';
    expect(decoded(await runPluginGuest(req, bridge().value))).toEqual({ name: "星空", count: 0 });
    req.inputJson = '{"name":99}';
    const host = bridge(); expect(await runPluginGuest(req, host.value)).toEqual({ ok: false, code: "invalid-input" });
    expect(host.events).toEqual([]);
  });

  it.each(["export const run = 42;", "export function other() {}"])("rejects an absent/non-callable export", async (source) => {
    expect((await execute(source)).result).toEqual({ ok: false, code: "missing-export" });
  });

  it("does not expose Node, browser or universal native IPC globals", async () => {
    const source = "export function run() { return ['process','require','Buffer','fetch','WebSocket','RTCPeerConnection','window','document','Deno','Bun','parentPort','electron'].map(key => typeof globalThis[key]); }";
    expect(decoded((await execute(source)).result)).toEqual(Array(12).fill("undefined"));
  });

  it("creates frozen null-prototype API namespaces and keeps function constructors in Guest", async () => {
    const source = `export async function run(input, api) { return {
      root: Object.getPrototypeOf(api) === null, nested: Object.getPrototypeOf(api.storage) === null,
      frozen: Object.isFrozen(api) && Object.isFrozen(api.storage),
      native: await api.storage.get.constructor('return typeof process')(),
      unknown: typeof api.workspace
    }; }`;
    const { result, value } = await execute(source, ["storage.get"]);
    expect(decoded(result)).toEqual({ root: true, nested: true, frozen: true, native: "undefined", unknown: "undefined" });
    expect(value.request).not.toHaveBeenCalled();
  });

  it("captures parsing/serialization before Guest mutates its JSON globals", async () => {
    const source = `JSON.parse = () => { throw new Error('changed parser'); }; JSON.stringify = () => { throw new Error('changed serializer'); };
      export async function run(input, api) { return await api.storage.get({ value: 42 }); }`;
    expect(decoded((await execute(source, ["storage.get"])).result)).toEqual({ value: 42 });
  });

  it.each(["node:fs", "https://example.invalid/file.js", "C:/file.js", "/file.js", "../../outside.js", "src/helper.js", "./missing.js"])("denies undeclared or nonrelative static import %s", async (specifier) => {
    const source = `import ${JSON.stringify(specifier)}; export function run() { return true; }`;
    expect((await execute(source)).result).toEqual({ ok: false, code: "module-denied" });
  });

  it.each(["node:fs", "https://example.invalid/file.js", "../../outside.js"])("denies dynamic import %s", async (specifier) => {
    const source = `export async function run() { return await import(${JSON.stringify(specifier)}); }`;
    expect((await execute(source)).result).toEqual({ ok: false, code: "module-denied" });
  });

  it("permits Guest to catch a rejected import without ever reaching a host loader", async () => {
    const { result } = await execute("export async function run() { try { await import('node:fs'); } catch { return 'denied'; } }");
    expect(decoded(result)).toBe("denied");
  });

  it("keeps invalid packages, action IDs, input and malformed WASM outside execution", async () => {
    const good = requestFor("export function run() { return 42; }");
    for (const [changes, code] of [
      [{ packageJson: "{}" }, "invalid-package"], [{ actionId: "missing" }, "invalid-input"],
      [{ inputJson: "[1]" }, "invalid-input"], [{ wasmBinary: new ArrayBuffer(8) }, "runner-unavailable"],
    ] as const) {
      expect(await runPluginGuest({ ...good, ...changes }, bridge().value)).toEqual({ ok: false, code });
    }
  });
});

describe("bounded asynchronous capability bridge", () => {
  it("dispatches declared capabilities with host-assigned IDs and structured arguments", async () => {
    const host = bridge();
    const req = requestFor("export async function run(input, api) { await api.log({ message: '开始' }); return await api.storage.get({ key: 'result' }); }", ["log", "storage.get"]);
    const result = await runPluginGuest(req, host.value);
    expect(decoded(result)).toEqual({ key: "result" });
    expect(host.value.request).toHaveBeenNthCalledWith(1, { id: 1, capability: "log", argsJson: '{"message":"开始"}' });
    expect(host.value.request).toHaveBeenNthCalledWith(2, { id: 2, capability: "storage.get", argsJson: '{"key":"result"}' });
  });

  it("keeps out-of-order host replies assigned to the correct Guest Promise", async () => {
    const requests: PluginCapabilityRequest[] = [];
    const request = vi.fn(async (call: PluginCapabilityRequest): Promise<PluginRunResult> => {
      requests.push(call); await new Promise((resolve) => setTimeout(resolve, call.id === 1 ? 15 : 0));
      return { ok: true, valueJson: JSON.stringify(call.id) };
    });
    const { result } = await execute("export async function run(input, api) { return await Promise.all([api.storage.get({key:'a'}), api.storage.get({key:'b'})]); }", ["storage.get"], { request });
    expect(decoded(result)).toEqual([1, 2]); expect(requests.map((call) => call.id)).toEqual([1, 2]);
  });

  it.each(["resolve", "cancel"] as const)("does not poll an idle host Promise, then handles %s", async (completion) => {
    const stateReads = vi.spyOn(QuickJSContext.prototype, "getPromiseState");
    const host = bridge();
    let announceRequest: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => { announceRequest = resolve; });
    let reply: ((result: PluginRunResult) => void) | undefined;
    host.value.request = vi.fn(() => new Promise<PluginRunResult>((resolve) => {
      reply = resolve; announceRequest?.();
    }));
    const running = runPluginGuest(requestFor("export async function run(input, api) { return await api.storage.get({key:'held'}); }", ["storage.get"]), host.value);
    try {
      await requested;
      // The request may be dispatched while switching from module loading to
      // the first action-state check. Measure idle only after that required pump.
      await vi.waitFor(() => { expect(stateReads.mock.calls.length).toBeGreaterThanOrEqual(2); }, { interval: 1, timeout: 1000 });
      const beforeIdle = stateReads.mock.calls.length;
      expect(beforeIdle).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stateReads.mock.calls).toHaveLength(beforeIdle);
      if (completion === "resolve") {
        reply?.({ ok: true, valueJson: '"resumed"' });
        expect(decoded(await running)).toBe("resumed");
        expect(stateReads.mock.calls.length).toBeGreaterThan(beforeIdle);
      } else {
        host.controller.abort();
        expect(await running).toEqual({ ok: false, code: "cancelled" });
      }
    } finally {
      host.controller.abort();
      await running;
      stateReads.mockRestore();
    }
  });

  it("makes host denial a fixed Guest rejection without exposing host diagnostics", async () => {
    const request = vi.fn(async (): Promise<PluginRunResult> => ({ ok: false, code: "capability-denied" }));
    expect(decoded((await execute("export async function run(input, api) { try { await api.commands.run({command:'anything'}); } catch (code) { return code; } }", ["commands.run"], { request })).result)).toBe("capability-denied");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps rejected host Promises to a fixed error and rejects invalid host messages", async () => {
    const source = "export async function run(input, api) { try { return await api.storage.get({}); } catch (code) { return code; } }";
    const request = vi.fn(async () => { throw new Error("private host path and key must stay private"); });
    expect(decoded((await execute(source, ["storage.get"], { request })).result)).toBe("host-error");
    const invalid = vi.fn(async () => ({ ok: true, valueJson: '"' + "a".repeat(PLUGIN_RUNTIME_LIMITS.outputBytes) + '"' } as PluginRunResult));
    expect((await execute(source, ["storage.get"], { request: invalid })).result).toEqual({ ok: false, code: "invalid-message" });
  });

  it("stops a revoked run even when Guest catches the rejection", async () => {
    const request = vi.fn(async (): Promise<PluginRunResult> => ({ ok: false, code: "revoked" }));
    const { result } = await execute("export async function run(input, api) { try { await api.storage.get({}); } catch {} return true; }", ["storage.get"], { request });
    expect(result).toEqual({ ok: false, code: "revoked" });
  });

  it("does not forward an oversized argument or arbitrary object across the boundary", async () => {
    const host = bridge();
    const source = `export async function run(input, api) { return await api.storage.get({ text: '字'.repeat(${Math.ceil(PLUGIN_RUNTIME_LIMITS.argsBytes / 3)}) }); }`;
    expect((await runPluginGuest(requestFor(source, ["storage.get"]), host.value)).ok).toBe(false);
    expect(host.value.request).not.toHaveBeenCalled();
  });

  it("does not skip a transport ID when Guest catches an invalid argument", async () => {
    const host = bridge();
    const source = "export async function run(input, api) { try { await api.storage.get({text:'x'.repeat(70000)}); } catch {} return await api.storage.get({key:'ok'}); }";
    expect(decoded(await runPluginGuest(requestFor(source, ["storage.get"]), host.value))).toEqual({ key: "ok" });
    expect(host.value.request).toHaveBeenCalledExactlyOnceWith({ id: 1, capability: "storage.get", argsJson: '{"key":"ok"}' });
  });

  it("caps parallel and sequential requests even when Guest attempts to catch limit errors", async () => {
    const parallel = bridge({ request: vi.fn(async () => new Promise<PluginRunResult>(() => {})) });
    const result = await runPluginGuest(requestFor("export async function run(input, api) { for(let i=0;i<20;i++) api.storage.get({i}).catch(()=>{}); return 'caught'; }", ["storage.get"]), parallel.value);
    expect(result).toEqual({ ok: false, code: "resource-limit" });
    expect(vi.mocked(parallel.value.request).mock.calls.length).toBeLessThanOrEqual(PLUGIN_RUNTIME_LIMITS.pending);
    const sequential = await execute("export async function run(input, api) { for(let i=0;i<100;i++) { try { await api.storage.get({i}); } catch {} } return true; }", ["storage.get"]);
    expect(sequential.result).toEqual({ ok: false, code: "resource-limit" });
    expect(sequential.value.request).toHaveBeenCalledTimes(PLUGIN_RUNTIME_LIMITS.requests);
  });

  it("cancels a pending call and ignores its reply after the VM was disposed", async () => {
    let resolveReply: ((result: PluginRunResult) => void) | undefined;
    const host = bridge();
    host.value.request = vi.fn(() => new Promise<PluginRunResult>((resolve) => {
      resolveReply = resolve;
      setTimeout(() => host.controller.abort(), 0);
    }));
    const result = await runPluginGuest(requestFor("export async function run(input, api) { return await api.storage.get({}); }", ["storage.get"]), host.value);
    expect(result).toEqual({ ok: false, code: "cancelled" });
    resolveReply?.({ ok: true, valueJson: '"late"' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.value.request).toHaveBeenCalledTimes(1);
    expect(decoded((await execute("export function run() { return 42; }")).result)).toBe(42);
  });

  it("fails an action that returns with an unawaited call and ignores late replies after outer cleanup", async () => {
    const host = bridge();
    let resolveLate: ((result: PluginRunResult) => void) | undefined;
    let brokerAborted = false;
    host.value.request = vi.fn((call: PluginCapabilityRequest): Promise<PluginRunResult> => {
      if (call.capability === "log") return Promise.resolve({ ok: true, valueJson: "null" });
      return new Promise<PluginRunResult>((resolve) => {
        resolveLate = resolve;
        host.value.signal.addEventListener("abort", () => { brokerAborted = true; }, { once: true });
      });
    });
    const source = "export async function run(input, api) { api.storage.get({key:'late'}).catch(()=>{}); await api.log({message:'returning'}); return {done:true}; }";
    const result = await runPluginGuest(requestFor(source, ["storage.get", "log"]), host.value);
    expect(result).toEqual({ ok: false, code: "guest-error" });
    expect(host.value.request).toHaveBeenCalledTimes(2);
    expect(resolveLate).toBeTypeOf("function");
    // The main service owns broker cancellation when any run result arrives.
    // Model that cleanup here; the engine must already have disposed its VM.
    host.controller.abort();
    expect(brokerAborted).toBe(true);
    resolveLate?.({ ok: true, valueJson: '"late result"' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(host.value.request).toHaveBeenCalledTimes(2);
    expect(decoded((await execute("export function run() { return 42; }")).result)).toBe(42);
  });

  it("handles cancellation before startup without emitting ready", async () => {
    const host = bridge(); host.controller.abort();
    expect(await runPluginGuest(requestFor("export function run() { return 42; }"), host.value)).toEqual({ ok: false, code: "cancelled" });
    expect(host.events).toEqual([]);
  });

  it("can cancel a never-resolving Guest Promise without counting idle wait as CPU", async () => {
    const host = bridge();
    host.value.onReady = () => { host.events.push("ready"); setTimeout(() => host.controller.abort(), 15); };
    expect(await runPluginGuest(requestFor("export async function run() { return await new Promise(()=>{}); }"), host.value)).toEqual({ ok: false, code: "cancelled" });
  });
});

describe("Guest resources and error ownership", () => {
  it("rejects a large Unicode result by bytes before returning it to the host", async () => {
    const { result } = await execute(`export function run() { return '字'.repeat(${Math.ceil(PLUGIN_RUNTIME_LIMITS.outputBytes / 3)}); }`);
    expect(result).toEqual({ ok: false, code: "resource-limit" });
  });

  it.each([
    "export function run() { const value={}; value.self=value; return value; }",
    "export function run() { throw new Error('x'.repeat(1000000)); }",
    "throw { get message() { while(true){} } }; export function run() {}",
    "export function run() { return 123n; }",
  ])("discards untrusted error handles without dump/unwrap or raw diagnostics", async (source) => {
    const { result } = await execute(source);
    expect(result).toEqual({ ok: false, code: "guest-error" });
  });

  it("bounds code that loops during module initialization", async () => {
    const { result } = await execute("while(true){} export function run() { return true; }");
    expect(result).toEqual({ ok: false, code: "resource-limit" });
  }, 5000);

  it("bounds code that loops while serializing the action result", async () => {
    const { result } = await execute("export function run() { return { get value() { while(true){} } }; }");
    expect(result).toEqual({ ok: false, code: "resource-limit" });
  }, 5000);

  it("caps endless pending jobs", async () => {
    const { result } = await execute("export function run() { const loop=()=>Promise.resolve().then(loop); return loop(); }");
    expect(result).toEqual({ ok: false, code: "resource-limit" });
  }, 5000);

  it("refuses allocations larger than the fixed linear memory and remains usable after failure", async () => {
    const { result } = await execute("export function run() { const values=[]; for(let i=0;i<160;i++) values.push(new ArrayBuffer(1024*1024)); return values.length; }");
    expect(result.ok).toBe(false);
    expect(decoded((await execute("export function run() { return 42; }")).result)).toBe(42);
  });
});
