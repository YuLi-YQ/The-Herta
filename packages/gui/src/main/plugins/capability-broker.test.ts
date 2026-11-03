import { afterEach, describe, expect, it, vi } from "vitest";
import { parseExecutablePluginManifest, type ExecutablePluginManifest } from "../../shared/executable-plugins.js";
import { PLUGIN_RUNTIME_LIMITS } from "../../shared/plugin-runtime.js";
import type { PluginControlledViewDefinition } from "../../shared/plugin-view.js";
import {
  PluginCapabilityBroker, PluginBrokerFault,
  type PluginBrokerBinding, type PluginBrokerPolicy, type PluginCapabilityHandlers, type PluginCapabilityContext,
} from "./capability-broker.js";

function fixture(handlers: PluginCapabilityHandlers = {}, scope: "chat" | "workbench" = "workbench") {
  const capabilities = [
    ...(scope === "workbench" ? [{ name: "workspace.readText" }, { name: "workspace.proposePatch" }, { name: "commands.run" }] : []),
    { name: "network.request", origins: ["https://a.example", "https://b.example"], methods: ["GET", "POST"] },
    ...["storage.get", "storage.set", "draft.append", "artifacts.create", "ui.present", "ui.update", "log", "progress"].map(name => ({ name })),
  ];
  const manifest = parseExecutablePluginManifest(JSON.stringify({
    schemaVersion: 2, apiVersion: 1, id: "example.broker", name: "Broker fixture", version: "1.0.0", description: "Synthetic only",
    entry: "main.js", capabilities,
    actions: [{ id: "run", title: "Run", scope, export: "run", inputs: [], capabilities: capabilities.map(cap => cap.name) }],
  }));
  const binding: PluginBrokerBinding = {
    pluginId: manifest.id, contentHash: "a".repeat(64), grantRevision: 1, sessionId: "fixture-session", sessionRevision: 1,
    permissionRevision: 1, scope, actionId: "run",
  };
  let policy: PluginBrokerPolicy | null = {
    ...binding, enabled: true, permissionMode: "workspace-edit", planActive: false, grantedCapabilities: manifest.capabilities,
  };
  const broker = new PluginCapabilityBroker({ manifest, binding, actionId: "run", current: () => policy, handlers });
  return { broker, binding, manifest, policy: () => policy!, setPolicy: (value: PluginBrokerPolicy | null) => { policy = value; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

describe("plugin capability broker default-deny boundary", () => {
  it("invokes only an injected declared and granted handler with owned args and minimal host context", async () => {
    let context!: PluginCapabilityContext;
    const handler = vi.fn((args, ctx: PluginCapabilityContext) => { context = ctx; return JSON.stringify({ text: args.key }); });
    const { broker, binding } = fixture({ "storage.get": handler });
    expect(await broker.call("storage.get", '{"key":"sample"}')).toEqual({ ok: true, valueJson: '{"text":"sample"}' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(Object.getPrototypeOf(handler.mock.calls[0]![0])).toBeNull();
    expect(Object.isFrozen(handler.mock.calls[0]![0])).toBe(true);
    expect(Object.keys(context).sort()).toEqual(["assertCurrent", "binding", "signal"]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(context.binding).toEqual(binding);
    expect(Object.isFrozen(context.binding)).toBe(true);
    expect(context.signal.aborted).toBe(true);
    expect(() => context.assertCurrent()).toThrow(PluginBrokerFault);
    broker.dispose();
  });

  it("denies unknown names, absent handlers, undeclared grants and action omissions", async () => {
    const handler = vi.fn(() => "null"), f = fixture({ "storage.get": handler });
    expect(await f.broker.call("fs", "{}")).toEqual({ ok: false, code: "capability-denied" });
    expect(await f.broker.call("storage.set", '{"key":"x","value":1}')).toEqual({ ok: false, code: "capability-denied" });
    f.setPolicy({ ...f.policy(), grantedCapabilities: [] });
    expect(await f.broker.call("storage.get", '{"key":"x"}')).toEqual({ ok: false, code: "capability-denied" });
    const declaration = { ...f.manifest, capabilities: f.manifest.capabilities.filter(c => c.name !== "storage.get"),
      actions: [{ ...f.manifest.actions[0]!, capabilities: f.manifest.actions[0]!.capabilities.filter(name => name !== "storage.get") }] };
    const noDeclaration = new PluginCapabilityBroker({ manifest: declaration, binding: f.binding, current: () => ({ ...f.policy(), grantedCapabilities: f.manifest.capabilities }), handlers: { "storage.get": handler } });
    expect(await noDeclaration.call("storage.get", '{"key":"x"}')).toEqual({ ok: false, code: "capability-denied" });
    const noAction = new PluginCapabilityBroker({ manifest: { ...f.manifest, actions: [
      { ...f.manifest.actions[0]!, capabilities: f.manifest.actions[0]!.capabilities.filter(name => name !== "storage.get") },
      { ...f.manifest.actions[0]!, id: "other", capabilities: ["storage.get"] },
    ] }, binding: f.binding, current: () => ({ ...f.policy(), grantedCapabilities: f.manifest.capabilities }), handlers: { "storage.get": handler } });
    expect(await noAction.call("storage.get", '{"key":"x"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).not.toHaveBeenCalled();
    [f.broker, noDeclaration, noAction].forEach(broker => broker.dispose());
  });

  it("freezes bindings and captures handlers without later external replacement", async () => {
    const initial = vi.fn(() => "true"), replacement = vi.fn(() => "false");
    const handlers = { "storage.get": initial }, f = fixture(handlers);
    Object.assign(f.binding, { sessionId: "changed-outside" }); handlers["storage.get"] = replacement;
    expect(f.broker.binding.sessionId).toBe("fixture-session");
    expect(await f.broker.call("storage.get", '{"key":"x"}')).toEqual({ ok: true, valueJson: "true" });
    expect(replacement).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("checks package/action/scope consistency at construction", () => {
    const f = fixture();
    for (const change of [{ actionId: "other" }, { binding: { ...f.binding, pluginId: "other.plugin" } }, { binding: { ...f.binding, scope: "chat" as const } }]) {
      expect(() => new PluginCapabilityBroker({ manifest: f.manifest, binding: f.binding, current: f.policy, handlers: {}, ...change })).toThrow(PluginBrokerFault);
    }
    f.broker.dispose();
  });

  it("requires a bound session, hash and finite revisions and strips accidental host fields", async () => {
    const f = fixture();
    for (const extra of [{ sessionId: "" }, { contentHash: "unverified" }, { grantRevision: -1 }, { sessionRevision: NaN }, { permissionRevision: undefined }]) {
      expect(() => new PluginCapabilityBroker({ manifest: f.manifest, binding: { ...f.binding, ...extra } as PluginBrokerBinding, current: f.policy, handlers: {} })).toThrow(PluginBrokerFault);
    }
    const broker = new PluginCapabilityBroker({ manifest: f.manifest, binding: { ...f.binding, secret: "not-a-binding-field" } as PluginBrokerBinding, current: f.policy, handlers: { "storage.get": (_args, ctx) => JSON.stringify(Object.keys(ctx.binding)) } });
    const result = await broker.call("storage.get", '{"key":"x"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.valueJson)).not.toContain("secret");
    broker.dispose(); f.broker.dispose();
  });

  it("rejects arbitrary HTML instead of forwarding it through a controlled-view handler", async () => {
    const handler = vi.fn(() => "null"), f = fixture({ "ui.present": handler, "ui.update": handler });
    expect(await f.broker.call("ui.present", '{"html":"<script>evil</script>"}')).toEqual({ ok: false, code: "invalid-input" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });
});

describe("controlled-view capability protocol", () => {
  const view = (): PluginControlledViewDefinition => ({ title: "结果", blocks: [{ type: "text", text: "普通数据" }],
    actions: [{ id: "open", label: "打开操作", actionId: "run", inputJson: '{ "value": 42 }' }] });

  it("forwards only a deeply owned definition to an explicitly granted present handler", async () => {
    let received: unknown;
    const handler = vi.fn((args: Readonly<{ view: PluginControlledViewDefinition }>, context: PluginCapabilityContext) => {
      context.assertCurrent(); received = args;
      expect(Object.isFrozen(args.view.actions[0])).toBe(true);
      expect(Object.isFrozen(args.view.blocks)).toBe(true);
      expect(Object.getPrototypeOf(args.view)).toBeNull();
      return '{"id":"host-view","revision":1}';
    });
    const f = fixture({ "ui.present": handler });
    expect(await f.broker.call("ui.present", JSON.stringify({ view: view() }))).toEqual({ ok: true, valueJson: '{"id":"host-view","revision":1}' });
    expect(received).toEqual({ view: { ...view(), actions: [{ ...view().actions[0], inputJson: '{"value":42}' }] } });
    f.broker.dispose();
  });

  it("passes an update's viewId and positive revision as data for controller CAS", async () => {
    const handler = vi.fn((_args: Readonly<{ viewId: string; revision: number; view: PluginControlledViewDefinition }>) => '{"id":"12345678-abcd-1234-abcd-123456789abc","revision":2}'), f = fixture({ "ui.update": handler });
    const request = { viewId: "12345678-abcd-1234-abcd-123456789abc", revision: 1, view: view() };
    expect((await f.broker.call("ui.update", JSON.stringify(request))).ok).toBe(true);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ viewId: request.viewId, revision: 1 }); f.broker.dispose();
  });

  it.each(["ui.present", "ui.update"])("keeps %s denied without a handler or current grant", async (capability) => {
    const args = capability === "ui.present" ? { view: view() } : { viewId: "host-view", revision: 1, view: view() };
    const absent = fixture(); expect(await absent.broker.call(capability, JSON.stringify(args))).toEqual({ ok: false, code: "capability-denied" }); absent.broker.dispose();
    const handler = vi.fn(() => "null"), f = fixture({ [capability]: handler });
    f.setPolicy({ ...f.policy(), grantedCapabilities: [] });
    expect(await f.broker.call(capability, JSON.stringify(args))).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("still intersects UI capabilities with manifest and current action declarations", async () => {
    const f = fixture(), handler = vi.fn(() => "null"), capability = "ui.present";
    const removed = { ...f.manifest, capabilities: f.manifest.capabilities.filter(item => item.name !== capability),
      actions: [{ ...f.manifest.actions[0]!, capabilities: f.manifest.actions[0]!.capabilities.filter(name => name !== capability) }] };
    const noDeclaration = new PluginCapabilityBroker({ manifest: removed, binding: f.binding, current: f.policy, handlers: { "ui.present": handler } });
    expect(await noDeclaration.call(capability, JSON.stringify({ view: view() }))).toEqual({ ok: false, code: "capability-denied" });
    const noAction = new PluginCapabilityBroker({ manifest: { ...f.manifest, actions: [removed.actions[0]!, { ...f.manifest.actions[0]!, id: "other", capabilities: [capability] }] },
      binding: f.binding, current: f.policy, handlers: { "ui.present": handler } });
    expect(await noAction.call(capability, JSON.stringify({ view: view() }))).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).not.toHaveBeenCalled(); [f.broker, noDeclaration, noAction].forEach(item => item.dispose());
  });

  it.each([
    { viewId: "", revision: 1 }, { viewId: "../other", revision: 1 }, { viewId: "x".repeat(101), revision: 1 },
    { viewId: "view", revision: 0 }, { viewId: "view", revision: -1 }, { viewId: "view", revision: 1.5 },
    { viewId: "view", revision: Number.MAX_SAFE_INTEGER }, { viewId: "view", revision: 1, runId: "other" },
  ])("rejects invalid or identity-bearing update envelopes %j", async (envelope) => {
    const handler = vi.fn(() => "null"), f = fixture({ "ui.update": handler });
    expect(await f.broker.call("ui.update", JSON.stringify({ ...envelope, view: view() }))).toEqual({ ok: false, code: "invalid-input" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it.each([
    { title: " ", blocks: [], actions: [] },
    { title: "x", blocks: [{ type: "html", html: "<script>" }], actions: [] },
    { title: "x", blocks: [{ type: "text", text: "\ud800" }], actions: [] },
    { title: "x", blocks: [], actions: [{ id: "x", label: "x", actionId: "run", inputJson: "[]" }] },
    { title: "x", blocks: [], actions: [], id: "forged-view" },
  ])("rejects unsafe view definitions as invalid-input before any host effect", async (definition) => {
    const handler = vi.fn(() => "null"), f = fixture({ "ui.present": handler });
    expect(await f.broker.call("ui.present", JSON.stringify({ view: definition }))).toEqual({ ok: false, code: "invalid-input" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("allows display-only UI under read-only/plan policy while retaining revocation checks", async () => {
    const handler = vi.fn(() => "null"), f = fixture({ "ui.present": handler }, "chat");
    f.setPolicy({ ...f.policy(), permissionMode: "read-only", planActive: true });
    expect(await f.broker.call("ui.present", JSON.stringify({ view: view() }))).toEqual({ ok: true, valueJson: "null" });
    f.setPolicy({ ...f.policy(), sessionRevision: 2 });
    expect(await f.broker.call("ui.present", JSON.stringify({ view: view() }))).toEqual({ ok: false, code: "revoked" });
    expect(handler).toHaveBeenCalledTimes(1); f.broker.dispose();
  });

  it("invalidates a pending view handler before it can commit its delayed result", async () => {
    const gate = deferred<void>(); let effects = 0;
    const f = fixture({ "ui.update": async (_args, context) => { await gate.promise; context.assertCurrent(); effects++; return "null"; } });
    const pending = f.broker.call("ui.update", JSON.stringify({ viewId: "view", revision: 1, view: view() }));
    f.broker.invalidate(); gate.resolve();
    expect(await pending).toEqual({ ok: false, code: "revoked" }); await Promise.resolve(); expect(effects).toBe(0);
  });
});

describe("current grants, scope and plan locks", () => {
  it.each(["pluginId", "contentHash", "grantRevision", "sessionId", "sessionRevision", "permissionRevision", "scope"] as const)("revokes when current %s no longer matches the run", async (key) => {
    const handler = vi.fn(() => "null"), f = fixture({ "storage.get": handler });
    f.setPolicy({ ...f.policy(), [key]: typeof f.policy()[key] === "number" ? 2 : "different" });
    expect(await f.broker.call("storage.get", '{"key":"x"}')).toEqual({ ok: false, code: "revoked" });
    expect(f.broker.signal.aborted).toBe(true); expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed on absent, disabled or throwing current policy", async () => {
    const f = fixture({ "storage.get": () => "null" }); f.setPolicy(null);
    expect(() => f.broker.assertCurrent()).toThrow(PluginBrokerFault);
    const disabled = fixture(); disabled.setPolicy({ ...disabled.policy(), enabled: false });
    expect(() => disabled.broker.assertCurrent()).toThrow(PluginBrokerFault);
    const broken = new PluginCapabilityBroker({ manifest: f.manifest, binding: f.binding, current: () => { throw Error("secret"); }, handlers: {} });
    expect(await broken.call("storage.get", "{}")).toEqual({ ok: false, code: "revoked" });
  });

  it.each(["read-only", "plan"])("denies arbitrary commands and workspace writes under %s without consulting a self-reported readOnly flag", async (kind) => {
    const mutation = vi.fn(() => "true"), read = vi.fn(() => '"contents"');
    const f = fixture({ "commands.run": mutation, "workspace.proposePatch": mutation, "workspace.readText": read });
    f.setPolicy({ ...f.policy(), permissionMode: kind === "read-only" ? "read-only" : "full-access", planActive: kind === "plan" });
    expect(await f.broker.call("commands.run", '{"argv":["git","status"]}')).toEqual({ ok: false, code: "capability-denied" });
    expect(await f.broker.call("workspace.proposePatch", '{"path":"x.txt","baseHash":null,"content":"x"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(await f.broker.call("workspace.readText", '{"path":"x.txt"}')).toEqual({ ok: true, valueJson: '"contents"' });
    expect(mutation).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("rejects a forged both-scope declaration and refuses workspace grants on an actual chat action", async () => {
    const f = fixture(), handler = vi.fn(() => "true");
    const manifest = { ...f.manifest, actions: [{ ...f.manifest.actions[0]!, scope: "both" }] } as ExecutablePluginManifest;
    const binding = { ...f.binding, scope: "chat" as const };
    expect(() => new PluginCapabilityBroker({ manifest, binding, current: () => ({ ...f.policy(), scope: "chat" }), handlers: { "workspace.readText": handler, "commands.run": handler } })).toThrow(PluginBrokerFault);
    const chat = fixture({}, "chat");
    const broker = new PluginCapabilityBroker({ manifest: chat.manifest, binding: chat.binding, current: () => ({ ...chat.policy(), grantedCapabilities: f.manifest.capabilities }), handlers: { "workspace.readText": handler, "commands.run": handler } });
    expect(await broker.call("workspace.readText", '{"path":"x.txt"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(await broker.call("commands.run", '{"argv":["echo","x"]}')).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).not.toHaveBeenCalled(); broker.dispose(); f.broker.dispose(); chat.broker.dispose();
  });

  it("keeps local draft/storage/artifact capabilities separate from workspace permissions", async () => {
    const f = fixture({ "storage.set": () => "null", "draft.append": () => "true", "artifacts.create": () => '"artifact-id"' }, "chat");
    f.setPolicy({ ...f.policy(), permissionMode: "read-only", planActive: true });
    expect((await f.broker.call("storage.set", '{"key":"prefs","value":{"x":1}}')).ok).toBe(true);
    expect((await f.broker.call("draft.append", '{"text":"草稿"}')).ok).toBe(true);
    expect((await f.broker.call("artifacts.create", '{"name":"report.txt","mime":"text/plain","text":"result"}')).ok).toBe(true);
    f.broker.dispose();
  });
});

describe("bounded capability-specific arguments", () => {
  it.each(["../outside", "/absolute", "C:/file", "a:stream", "src/../file", "src//file", "src/file.", "src/file ", "NUL.txt", "src/a\nb", "src/\ud800"])("denies ambiguous workspace path %s before calling host", async (path) => {
    const handler = vi.fn(() => "null"), f = fixture({ "workspace.readText": handler });
    expect(await f.broker.call("workspace.readText", JSON.stringify({ path }))).toEqual({ ok: false, code: "invalid-input" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("normalizes relative Windows separators while leaving actual path containment to the handler", async () => {
    const handler = vi.fn((_args: Readonly<{ path: string; maxBytes?: number }>) => "null"), f = fixture({ "workspace.readText": handler });
    expect((await f.broker.call("workspace.readText", JSON.stringify({ path: "src\\黑塔.txt", maxBytes: 1024 }))).ok).toBe(true);
    expect(handler.mock.calls[0]![0]).toEqual({ path: "src/黑塔.txt", maxBytes: 1024 }); f.broker.dispose();
  });

  it.each([
    ["workspace.readText", { path: "x", sessionId: "other" }],
    ["workspace.proposePatch", { path: "x", baseHash: "bad", content: "x" }],
    ["commands.run", { argv: ["pwsh"], readOnly: true }],
    ["commands.run", { argv: [], timeoutMs: 1 }],
    ["commands.run", { argv: ["echo"], env: { KEY: "secret" } }],
    ["storage.get", { key: "../secret" }],
    ["storage.set", { key: "x" }],
    ["draft.append", { text: "x", send: true }],
    ["artifacts.create", { name: "../core.js", mime: "text/plain", text: "x" }],
    ["artifacts.create", { name: "x", mime: "application/octet-stream", text: "x" }],
    ["log", { level: "debug", message: "x" }],
    ["progress", { message: "x", value: 2 }],
  ])("rejects unsafe %s arguments", async (name, args) => {
    const handler = vi.fn(() => "null"), f = fixture({ [name as string]: handler });
    expect(await f.broker.call(name, JSON.stringify(args))).toEqual({ ok: false, code: "invalid-input" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("does not reflect over caller objects and respects UTF8/depth/array limits", async () => {
    const hook = vi.fn(), proxy = new Proxy({}, { get: hook, ownKeys: hook }), handler = vi.fn(() => "null");
    const f = fixture({ "storage.set": handler });
    expect(await f.broker.call("storage.set", proxy)).toEqual({ ok: false, code: "invalid-input" });
    expect(await f.broker.call("storage.set", JSON.stringify({ key: "x", value: "字".repeat(30000) }))).toEqual({ ok: false, code: "invalid-input" });
    expect(await f.broker.call("storage.set", '{"key":"x","value":' + "[".repeat(14) + "0" + "]".repeat(14) + "}")).toEqual({ ok: false, code: "invalid-input" });
    expect(await f.broker.call("storage.set", '{"key":"x","value":{"__proto__":{"polluted":true}}}')).toEqual({ ok: false, code: "invalid-input" });
    expect(hook).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });

  it("allows valid command, patch, log and progress fields without adding host privileges", async () => {
    const handler = vi.fn(() => "null"), f = fixture({ "commands.run": handler, "workspace.proposePatch": handler, log: handler, progress: handler });
    for (const [name, args] of [["commands.run", { argv: ["echo", "hello"], cwd: "src", timeoutMs: 5000 }], ["workspace.proposePatch", { path: "x.txt", baseHash: "a".repeat(64), content: "new" }], ["log", { level: "warn", message: "fixture" }], ["progress", { message: "working", value: 0.5 }]]) {
      expect((await f.broker.call(name, JSON.stringify(args))).ok).toBe(true);
    }
    expect(handler).toHaveBeenCalledTimes(4); f.broker.dispose();
  });
});

describe("declared and current granted network restriction intersection", () => {
  it("keeps a canonical manifest snapshot even if its trusted source object is later changed", async () => {
    const f = fixture(), original = JSON.parse(JSON.stringify(f.manifest)), handler = vi.fn(() => "null");
    const broker = new PluginCapabilityBroker({ manifest: original, binding: f.binding, current: f.policy, handlers: { "network.request": handler } });
    const before = broker.manifestJson;
    original.capabilities.find((cap: { name: string }) => cap.name === "network.request").origins.push("https://outside.example");
    f.setPolicy({ ...f.policy(), grantedCapabilities: [{ name: "network.request", origins: ["https://outside.example"], methods: ["GET"] }] });
    expect(broker.manifestJson).toBe(before);
    expect(broker.manifestJson).toBe(JSON.stringify(f.manifest));
    expect(await broker.call("network.request", '{"url":"https://outside.example/","method":"GET"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).not.toHaveBeenCalled(); broker.dispose(); f.broker.dispose();
  });

  it.each(["read-only", "plan"])("denies network in workbench %s while keeping independent chat grants", async (mode) => {
    const handler = vi.fn(() => "null"), f = fixture({ "network.request": handler });
    f.setPolicy({ ...f.policy(), permissionMode: mode === "read-only" ? "read-only" : "full-access", planActive: mode === "plan" });
    expect(await f.broker.call("network.request", '{"url":"https://a.example/","method":"POST","body":"x"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(await f.broker.call("network.request", '{"url":"https://a.example/","method":"GET"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
    const chat = fixture({ "network.request": handler }, "chat");
    chat.setPolicy({ ...chat.policy(), permissionMode: "read-only", planActive: true });
    expect((await chat.broker.call("network.request", '{"url":"https://a.example/","method":"POST","body":"x"}')).ok).toBe(true);
    chat.broker.dispose();
  });

  it("allows only exact declared and granted origins and methods", async () => {
    const handler = vi.fn(() => '"synthetic-response"'), f = fixture({ "network.request": handler });
    f.setPolicy({ ...f.policy(), grantedCapabilities: [{ name: "network.request", origins: ["https://a.example"], methods: ["GET"] }] });
    expect((await f.broker.call("network.request", '{"url":"https://a.example/path?q=1","method":"GET"}')).ok).toBe(true);
    for (const request of [{ url: "https://b.example/path", method: "GET" }, { url: "https://a.example/path", method: "POST" }, { url: "https://a.example.evil/path", method: "GET" }]) {
      expect(await f.broker.call("network.request", JSON.stringify(request))).toEqual({ ok: false, code: "capability-denied" });
    }
    f.setPolicy({ ...f.policy(), grantedCapabilities: [{ name: "network.request", origins: ["https://outside.example"], methods: ["GET"] }] });
    expect(await f.broker.call("network.request", '{"url":"https://outside.example/","method":"GET"}')).toEqual({ ok: false, code: "capability-denied" });
    expect(handler).toHaveBeenCalledTimes(1); f.broker.dispose();
  });

  it.each([
    { url: "http://a.example/", method: "GET" }, { url: "https://user:pass@a.example/", method: "GET" },
    { url: "https://a.example/#fragment", method: "GET" }, { url: "https://a.ex\nample/", method: "GET" },
    { url: "https://a.example/#", method: "GET" }, { url: "https://a.example:0/", method: "GET" },
    { url: "https://a.example/", method: "GET", headers: { Authorization: "secret" } },
    { url: "https://a.example/", method: "GET", body: "x" }, { url: "https://a.example/", method: "TRACE" },
  ])("rejects credentials, unsupported channels and ambiguous URLs: %j", async (request) => {
    const handler = vi.fn(() => "null"), f = fixture({ "network.request": handler });
    expect(await f.broker.call("network.request", JSON.stringify(request))).toEqual({ ok: false, code: "invalid-input" });
    expect(handler).not.toHaveBeenCalled(); f.broker.dispose();
  });
});

describe("in-flight lifecycle and bounded results", () => {
  it("aborts and settles pending calls immediately on invalidation, ignoring late success and rejection", async () => {
    const a = deferred<string>(), b = deferred<string>(), contexts: PluginCapabilityContext[] = [];
    const f = fixture({ "storage.get": (_args, ctx) => { contexts.push(ctx); return contexts.length === 1 ? a.promise : b.promise; } });
    const first = f.broker.call("storage.get", '{"key":"a"}'), second = f.broker.call("storage.get", '{"key":"b"}');
    f.broker.invalidate();
    expect(await first).toEqual({ ok: false, code: "revoked" }); expect(await second).toEqual({ ok: false, code: "revoked" });
    expect(contexts.every(ctx => ctx.signal.aborted)).toBe(true);
    a.resolve("true"); b.reject(Error("late-private-error")); await Promise.resolve();
    expect(await f.broker.call("storage.get", '{"key":"new"}')).toEqual({ ok: false, code: "revoked" });
  });

  it("rejects a replaced session on completion even without an explicit invalidate callback", async () => {
    const response = deferred<string>(), f = fixture({ "storage.get": () => response.promise });
    const call = f.broker.call("storage.get", '{"key":"x"}');
    f.setPolicy({ ...f.policy(), sessionId: "new-session" }); response.resolve("true");
    expect(await call).toEqual({ ok: false, code: "revoked" }); expect(f.broker.signal.aborted).toBe(true);
  });

  it("rechecks grant narrowing after await even if a faulty host forgot to advance its revision", async () => {
    const response = deferred<string>(), f = fixture({ "network.request": () => response.promise });
    const call = f.broker.call("network.request", '{"url":"https://a.example/","method":"GET"}');
    f.setPolicy({ ...f.policy(), grantedCapabilities: [{ name: "network.request", origins: ["https://b.example"], methods: ["GET"] }] }); response.resolve("true");
    expect(await call).toEqual({ ok: false, code: "capability-denied" }); f.broker.dispose();
  });

  it("lets trusted handlers check the current plan immediately before a side effect", async () => {
    const approval = deferred<void>(); let effects = 0;
    const f = fixture({ "workspace.proposePatch": async (_args, ctx) => { await approval.promise; ctx.assertCurrent(); effects++; return "true"; } });
    const call = f.broker.call("workspace.proposePatch", '{"path":"x.txt","baseHash":null,"content":"x"}');
    f.setPolicy({ ...f.policy(), planActive: true }); approval.resolve();
    expect(await call).toEqual({ ok: false, code: "capability-denied" }); expect(effects).toBe(0); f.broker.dispose();
  });

  it("supports external cancellation and already-aborted starts", async () => {
    const f = fixture(), stop = new AbortController(), response = deferred<string>();
    const broker = new PluginCapabilityBroker({ manifest: f.manifest, binding: f.binding, current: f.policy, handlers: { "storage.get": () => response.promise }, signal: stop.signal });
    const call = broker.call("storage.get", '{"key":"x"}'); stop.abort();
    expect(await call).toEqual({ ok: false, code: "cancelled" }); response.resolve("true");
    const already = new PluginCapabilityBroker({ manifest: f.manifest, binding: f.binding, current: f.policy, handlers: {}, signal: stop.signal });
    expect(await already.call("storage.get", "{}")).toEqual({ ok: false, code: "cancelled" }); f.broker.dispose();
  });

  it("expires a single pending capability after sixty seconds and rejects retained contexts", async () => {
    vi.useFakeTimers(); const response = deferred<string>(); let context!: PluginCapabilityContext;
    const f = fixture({ "storage.get": (_args, ctx) => { context = ctx; return response.promise; } });
    const call = f.broker.call("storage.get", '{"key":"x"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await call).toEqual({ ok: false, code: "timeout" }); expect(context.signal.aborted).toBe(true);
    expect(() => context.assertCurrent()).toThrow(PluginBrokerFault); response.resolve("true"); f.broker.dispose();
  });

  it("caps simultaneous and lifetime requests before invoking a handler", async () => {
    const response = deferred<string>(), handler = vi.fn(() => response.promise), f = fixture({ "storage.get": handler });
    const calls = Array.from({ length: PLUGIN_RUNTIME_LIMITS.pending }, () => f.broker.call("storage.get", '{"key":"x"}'));
    expect(await f.broker.call("storage.get", '{"key":"extra"}')).toEqual({ ok: false, code: "resource-limit" });
    expect(handler).toHaveBeenCalledTimes(PLUGIN_RUNTIME_LIMITS.pending); f.broker.dispose();
    expect((await Promise.all(calls)).every(result => !result.ok && result.code === "cancelled")).toBe(true); response.resolve("null");
    const g = fixture({ "storage.get": () => "null" });
    for (let index = 0; index < PLUGIN_RUNTIME_LIMITS.requests; index++) expect((await g.broker.call("storage.get", '{"key":"x"}')).ok).toBe(true);
    expect(await g.broker.call("storage.get", '{"key":"last"}')).toEqual({ ok: false, code: "resource-limit" }); g.broker.dispose();
  });

  it("sanitizes host failures and rejects malformed or oversized returned JSON", async () => {
    for (const handler of [() => "not JSON", () => '"' + "x".repeat(PLUGIN_RUNTIME_LIMITS.outputBytes) + '"', () => ({ get value() { throw Error("not invoked"); } }) as unknown as string]) {
      const f = fixture({ "storage.get": handler });
      expect(await f.broker.call("storage.get", '{"key":"x"}')).toEqual({ ok: false, code: "invalid-message" }); f.broker.dispose();
    }
    for (const handler of [() => { throw Error("SECRET path and key"); }, async () => { throw Error("SECRET asynchronous failure"); }]) {
      const f = fixture({ "storage.get": handler });
      expect(await f.broker.call("storage.get", '{"key":"x"}')).toEqual({ ok: false, code: "host-error" }); f.broker.dispose();
    }
  });
});
