import { describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelRequest, ProviderConfig } from "@herta/providers";
import { createPluginGenerator, PluginGeneratorFault, type PluginGeneratorInput } from "./plugin-generator.js";
import { parseExecutablePluginPackage, EXECUTABLE_PLUGIN_LIMITS, EXECUTABLE_PLUGIN_CAPABILITY_NAMES } from "../../shared/executable-plugins.js";
import { PLUGIN_AUTHORING_EXAMPLE, PLUGIN_AUTHORING_GUIDE } from "../../shared/plugin-authoring-guide.js";

vi.mock("../provider-settings.js", () => ({
  acquireChatProvider: vi.fn(() => { throw new Error("real credentials must not be used"); }),
  getProviderSettings: vi.fn(() => { throw new Error("real profile must not be read"); }),
}));
const input: PluginGeneratorInput = { requestId: "synthetic-generation", brief: "整理输入文字并展示", providerId: "synthetic-provider", modelId: "synthetic-text-model", providerRevision: 1 };
function provider(): ProviderConfig {
  return { id: input.providerId, name: "Synthetic", protocol: "openai-chat-completions", baseURL: "https://synthetic.invalid/v1",
    authentication: "api-key", credentialRef: null, allowRemoteHTTP: false, revision: 1,
    defaults: { model: input.modelId, timeoutMs: 1000 },
    models: [{ id: input.modelId, source: "manual", capabilities: { streaming: "supported", tools: "unsupported", images: "unsupported", reasoning: "unsupported" },
      validation: { state: "text-available", protocol: "openai-chat-completions", providerRevision: 1 } }] };
}
async function* events(values: readonly ModelEvent[]) { for (const event of values) yield event; }
function fixture(stream: (request: ModelRequest) => AsyncIterable<ModelEvent>, timings?: { wallMs?: number; pollMs?: number }) {
  let config = provider(), request: ModelRequest | undefined;
  const release = vi.fn(), acquire = vi.fn(() => ({ config: structuredClone(config), key: "synthetic-key-not-for-output", release }));
  const adapter = vi.fn(() => ({ protocol: config.protocol, stream: (value: ModelRequest) => { request = value; return stream(value); },
    listModels: async () => ({ models: [], nextCursor: null }) }));
  const generator = createPluginGenerator({ acquire, readProvider: () => config, adapter, timings });
  const abort = new AbortController();
  return { generator, acquire, release, adapter, abort, guard: { signal: abort.signal, assertCurrent() {} },
    config: () => config, change: (next: ProviderConfig) => { config = next; }, request: () => request };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("R145 plugin generator", () => {
  it("uses a verified text-only selection, bounded prior data and the real guide, then parses the single fenced JSON with split Unicode", async () => {
    const pkg = JSON.parse(PLUGIN_AUTHORING_EXAMPLE); pkg.manifest.name += "🪄";
    const json = JSON.stringify(pkg), fence = String.fromCharCode(96).repeat(3), raw = fence + "json\n" + json + "\n" + fence;
    const split = raw.indexOf("🪄") + 1;
    const f = fixture(() => events([{ type: "text-delta", text: raw.slice(0, split) }, { type: "text-delta", text: raw.slice(split) }, { type: "finished", reason: "stop" }]));
    const progress = vi.fn(), result = await f.generator.generate({ ...input, previousPackageJson: PLUGIN_AUTHORING_EXAMPLE }, f.guard, progress);
    expect(result).toMatchObject({ providerId: input.providerId, modelId: input.modelId, providerRevision: 1, outputBytes: Buffer.byteLength(raw) });
    expect(JSON.parse(result.packageJson).manifest.name).toBe(pkg.manifest.name);
    expect(parseExecutablePluginPackage(PLUGIN_AUTHORING_EXAMPLE).manifest.apiVersion).toBe(1);
    expect(f.request()).toMatchObject({ tools: [], options: { webSearch: false, maxWebSearchUses: 0 }, modelId: input.modelId });
    expect(f.request()!.messages).toHaveLength(1);
    const message = f.request()!.messages[0]!;
    if (message.role !== "user") throw new Error("Expected only the explicit authoring input.");
    expect(JSON.parse(message.text)).toEqual({ brief: input.brief, previousPackageJson: PLUGIN_AUTHORING_EXAMPLE });
    expect(f.request()!.system).toContain(PLUGIN_AUTHORING_GUIDE);
    for (const name of EXECUTABLE_PLUGIN_CAPABILITY_NAMES) expect(PLUGIN_AUTHORING_GUIDE).toContain(name);
    expect(f.request()!.system).not.toContain("synthetic-key-not-for-output");
    expect(progress).toHaveBeenLastCalledWith(raw.length); expect(f.release).toHaveBeenCalledOnce();
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("rejects stale or unsupported selections and oversized previous candidates before acquiring credentials", async () => {
    const f = fixture(() => events([]));
    await expect(f.generator.generate({ ...input, providerRevision: 2 }, f.guard)).rejects.toMatchObject({ reason: "configuration" });
    await expect(f.generator.generate({ ...input, reasoningEffort: "unavailable-effort" }, f.guard)).rejects.toMatchObject({ reason: "configuration" });
    await expect(f.generator.generate({ ...input, previousPackageJson: "x".repeat(EXECUTABLE_PLUGIN_LIMITS.jsonBytes + 1) }, f.guard)).rejects.toMatchObject({ reason: "invalid" });
    expect(f.acquire).not.toHaveBeenCalled(); expect(f.adapter).not.toHaveBeenCalled();
  });
  it("rejects incomplete, tool/search, oversized and invalid package outputs with fixed errors and exactly one release", async () => {
    const fence = String.fromCharCode(96).repeat(3);
    const samples: { output: ModelEvent[]; reason: string }[] = [
      { output: [{ type: "text-delta", text: PLUGIN_AUTHORING_EXAMPLE }], reason: "incomplete" },
      { output: [{ type: "finished", reason: "length" }], reason: "incomplete" },
      { output: [{ type: "tool-arguments-delta", callId: "x", tool: "synthetic-key-not-for-output", delta: "{}" }], reason: "incomplete" },
      { output: [{ type: "web-search", id: "x", status: "completed" }], reason: "incomplete" },
      { output: [{ type: "text-delta", text: "x".repeat(EXECUTABLE_PLUGIN_LIMITS.jsonBytes + 1) }], reason: "output-limit" },
      { output: [{ type: "text-delta", text: fence + "json\n{}\n" + fence + "\n" + fence + "json\n{}\n" + fence }, { type: "finished", reason: "stop" }], reason: "invalid-package" },
    ];
    for (const sample of samples) {
      const f = fixture(() => events(sample.output));
      const failure = await f.generator.generate(input, f.guard).catch(error => error);
      expect(failure).toBeInstanceOf(PluginGeneratorFault); expect(failure.reason).toBe(sample.reason);
      expect(failure.message).not.toContain("synthetic-key-not-for-output"); expect(f.release).toHaveBeenCalledOnce();
    }
    const failed = fixture(async function* () { throw new Error("synthetic-key-not-for-output raw private response"); });
    await expect(failed.generator.generate(input, failed.guard)).rejects.toMatchObject({ reason: "provider", message: "模型未能完成插件生成，请检查连接或模型后重试。" });
    expect(failed.release).toHaveBeenCalledOnce();
  });
  it("actively aborts cancellation, selected configuration changes, timeout and disposal, dropping late output", async () => {
    for (const mode of ["cancel", "configuration", "timeout", "dispose"] as const) {
      const held = deferred<IteratorResult<ModelEvent>>(), began = deferred<void>(), returned = vi.fn(async () => ({ done: true as const, value: undefined }));
      const f = fixture(() => ({ [Symbol.asyncIterator]() { began.resolve(); return { next: () => held.promise, return: returned }; } }), { wallMs: mode === "timeout" ? 30 : 500, pollMs: 10 });
      const progress = vi.fn(), task = f.generator.generate(input, f.guard, progress).catch(error => error);
      await began.promise;
      await expect(f.generator.generate({ ...input, requestId: "second" }, f.guard)).rejects.toMatchObject({ reason: "busy" });
      if (mode === "cancel") f.abort.abort();
      if (mode === "configuration") f.change({ ...f.config(), revision: 2 });
      if (mode === "dispose") f.generator.dispose();
      const failure = await task;
      expect(failure).toMatchObject({ reason: mode === "cancel" ? "cancelled" : mode === "dispose" ? "disposed" : mode });
      expect(f.request()!.signal.aborted).toBe(true); expect(f.release).toHaveBeenCalledOnce(); expect(returned).toHaveBeenCalledOnce();
      held.resolve({ done: false, value: { type: "text-delta", text: PLUGIN_AUTHORING_EXAMPLE } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(progress).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
    }
  });
});
