import {
  EXECUTABLE_PLUGIN_CAPABILITY_NAMES,
  parseExecutablePluginManifest,
  type ExecutablePluginCapability,
  type ExecutablePluginCapabilityName,
  type ExecutablePluginHttpMethod,
  type ExecutablePluginManifest,
} from "../../shared/executable-plugins.js";
import {
  PLUGIN_RUNTIME_LIMITS,
  parsePluginJson,
  type PluginRunResult,
  type PluginRuntimeFaultCode,
} from "../../shared/plugin-runtime.js";
import { parsePluginControlledView, type PluginControlledViewDefinition } from "../../shared/plugin-view.js";

/** Host-created identity. None of these fields are accepted in a Guest request. */
export interface PluginBrokerBinding {
  readonly pluginId: string;
  readonly contentHash: string;
  readonly grantRevision: number;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly permissionRevision: number;
  readonly scope: "chat" | "workbench";
  readonly actionId: string;
}
export interface PluginBrokerPolicy extends Omit<PluginBrokerBinding, "actionId"> {
  readonly enabled: boolean;
  readonly permissionMode: "read-only" | "workspace-edit" | "full-access";
  readonly planActive: boolean;
  readonly grantedCapabilities: readonly ExecutablePluginCapability[];
}

export interface PluginCapabilityArguments {
  "workspace.readText": Readonly<{ path: string; maxBytes?: number }>;
  "workspace.proposePatch": Readonly<{ path: string; baseHash: string | null; content: string }>;
  "commands.run": Readonly<{ argv: readonly string[]; cwd?: string; timeoutMs?: number }>;
  "network.request": Readonly<{ url: string; method: ExecutablePluginHttpMethod; body?: string }>;
  "storage.get": Readonly<{ key: string }>;
  "storage.set": Readonly<{ key: string; value: unknown }>;
  "draft.append": Readonly<{ text: string }>;
  "artifacts.create": Readonly<{ name: string; mime: string; text: string }>;
  "log": Readonly<{ level: "info" | "warn" | "error"; message: string }>;
  "progress": Readonly<{ message: string; value?: number }>;
  "ui.present": Readonly<{ view: PluginControlledViewDefinition }>;
  "ui.update": Readonly<{ viewId: string; revision: number; view: PluginControlledViewDefinition }>;
}
export type PluginBrokerCapability = keyof PluginCapabilityArguments;
export interface PluginCapabilityContext {
  readonly binding: PluginBrokerBinding;
  readonly signal: AbortSignal;
  /** Call immediately before each real side effect, also after approval/I/O awaits. */
  assertCurrent(): void;
}
export type PluginCapabilityHandlers = {
  readonly [C in PluginBrokerCapability]?: (
    args: PluginCapabilityArguments[C], context: PluginCapabilityContext,
  ) => string | Promise<string>;
};
export interface PluginBrokerObservation {
  readonly requestId: number;
  readonly capability: ExecutablePluginCapabilityName | null;
  readonly phase: "requested" | "settled";
  readonly code?: PluginRuntimeFaultCode;
}
export interface PluginCapabilityBrokerOptions {
  readonly manifest: ExecutablePluginManifest;
  readonly actionId?: string;
  readonly binding: PluginBrokerBinding;
  readonly current: () => PluginBrokerPolicy | null;
  readonly handlers: PluginCapabilityHandlers;
  readonly signal?: AbortSignal;
  /** Host diagnostics only. No arguments, returned values or raw errors are exposed. */
  readonly observe?: (event: PluginBrokerObservation) => void;
}

/** Fixed codes only: no exception stack, path or provider data crosses to Guest. */
export class PluginBrokerFault extends Error {
  constructor(readonly code: PluginRuntimeFaultCode) { super(code); this.name = "PluginBrokerFault"; }
}
function denied(code: PluginRuntimeFaultCode): never { throw new PluginBrokerFault(code); }
const resultError = (error: unknown): PluginRunResult => ({
  ok: false, code: error instanceof PluginBrokerFault ? error.code : "host-error",
});
const CAPABILITY_NAMES = new Set<string>(EXECUTABLE_PLUGIN_CAPABILITY_NAMES);
const WORKSPACE = new Set<string>(["workspace.readText", "workspace.proposePatch", "commands.run"]);
const MUTATING_WORKSPACE = new Set<string>(["workspace.proposePatch", "commands.run"]);
const BINDING_KEYS = ["pluginId", "contentHash", "grantRevision", "sessionId", "sessionRevision", "permissionRevision", "scope"] as const;
const HTTP_METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ARTIFACT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
/** A capability wait includes approval. A longer approval policy must be added explicitly. */
const CALL_TIMEOUT_MS = 60_000;
type AnyHandler = (args: PluginCapabilityArguments[PluginBrokerCapability], context: PluginCapabilityContext) => string | Promise<string>;

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied("invalid-input");
  if (Object.keys(value).some((key) => !keys.includes(key))) denied("invalid-input");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim())
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) denied("invalid-input");
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) denied("invalid-input");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) denied("invalid-input");
  }
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) denied("invalid-input");
  return value;
}
function own<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, value));
}
/** Lexical scope only. A real handler must still resolve junctions/symlinks and enforce tool paths. */
function workspacePath(value: unknown): string {
  const path = text(value, 1024).replaceAll("\\", "/");
  if (path.includes(":") || path.startsWith("/") || /[\u0000-\u001f]/.test(path)) denied("invalid-input");
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.trim() !== segment || segment.endsWith(".")
      || /[<>"|?*]/.test(segment) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)) denied("invalid-input");
  }
  return path;
}
function storageKey(value: unknown): string {
  const key = text(value, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) denied("invalid-input");
  return key;
}
function argsFor(name: ExecutablePluginCapabilityName, raw: unknown): PluginCapabilityArguments[PluginBrokerCapability] {
  switch (name) {
    case "workspace.readText": {
      const input = object(raw, ["path", "maxBytes"]);
      return own({ path: workspacePath(input.path), ...(input.maxBytes === undefined ? {} : { maxBytes: integer(input.maxBytes, 1, 128 * 1024) }) });
    }
    case "workspace.proposePatch": {
      const input = object(raw, ["path", "baseHash", "content"]);
      if (input.baseHash !== null && (typeof input.baseHash !== "string" || !/^[a-f0-9]{64}$/.test(input.baseHash))) denied("invalid-input");
      return own({ path: workspacePath(input.path), baseHash: input.baseHash, content: text(input.content, 48000, true) });
    }
    case "commands.run": {
      const input = object(raw, ["argv", "cwd", "timeoutMs"]);
      if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 64) denied("invalid-input");
      const argv = Object.freeze(input.argv.map((item, index) => text(item, 2048, index !== 0)));
      return own({ argv, ...(input.cwd === undefined ? {} : { cwd: workspacePath(input.cwd) }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: integer(input.timeoutMs, 1, CALL_TIMEOUT_MS) }) });
    }
    case "network.request": {
      const input = object(raw, ["url", "method", "body"]), url = text(input.url, 2048);
      if (/[\u0000-\u0020\\#]/.test(url) || typeof input.method !== "string" || !HTTP_METHODS.has(input.method)) denied("invalid-input");
      let parsed: URL;
      try { parsed = new URL(url); } catch { return denied("invalid-input"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port === "0") denied("invalid-input");
      if (input.body !== undefined && (input.method === "GET" || input.method === "HEAD")) denied("invalid-input");
      return own({ url: parsed.href, method: input.method as ExecutablePluginHttpMethod,
        ...(input.body === undefined ? {} : { body: text(input.body, 48000, true) }) });
    }
    case "storage.get": {
      const input = object(raw, ["key"]); return own({ key: storageKey(input.key) });
    }
    case "storage.set": {
      const input = object(raw, ["key", "value"]);
      if (!Object.hasOwn(input, "value")) denied("invalid-input");
      return own({ key: storageKey(input.key), value: input.value });
    }
    case "draft.append": {
      const input = object(raw, ["text"]); return own({ text: text(input.text, 32000) });
    }
    case "artifacts.create": {
      const input = object(raw, ["name", "mime", "text"]), name = workspacePath(input.name);
      if (name.includes("/") || name.length > 160 || typeof input.mime !== "string" || !ARTIFACT_MIMES.has(input.mime)) denied("invalid-input");
      return own({ name, mime: input.mime, text: text(input.text, 48000, true) });
    }
    case "log": {
      const input = object(raw, ["level", "message"]);
      if (input.level !== "info" && input.level !== "warn" && input.level !== "error") denied("invalid-input");
      return own({ level: input.level, message: text(input.message, 2000) });
    }
    case "progress": {
      const input = object(raw, ["message", "value"]);
      if (input.value !== undefined && (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0 || input.value > 1)) denied("invalid-input");
      return own({ message: text(input.message, 500), ...(input.value === undefined ? {} : { value: input.value as number }) });
    }
    case "ui.present": {
      const input = object(raw, ["view"]);
      // raw is already parser-owned JSON data. Never stringify a native object
      // supplied directly by a plugin/renderer to the view parser.
      try { return own({ view: parsePluginControlledView(JSON.stringify(input.view)) }); }
      catch { return denied("invalid-input"); }
    }
    case "ui.update": {
      const input = object(raw, ["viewId", "revision", "view"]), viewId = text(input.viewId, 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(viewId)) denied("invalid-input");
      const revision = integer(input.revision, 1, Number.MAX_SAFE_INTEGER - 1);
      try { return own({ viewId, revision, view: parsePluginControlledView(JSON.stringify(input.view)) }); }
      catch { return denied("invalid-input"); }
    }
  }
}

/**
 * Default-deny gate only: handlers are trusted host code, not plugin code. No
 * ToolContext, fs, command runner, provider key, network client or global IPC is
 * provided here. A handler must apply real path/network/approval rules and call
 * context.assertCurrent() immediately before committing. Cancelling a result
 * cannot roll back a side effect that the handler already committed.
 */
export class PluginCapabilityBroker {
  readonly binding: PluginBrokerBinding;
  /** Service must compare this canonical declaration with the package it actually executes. */
  readonly manifestJson: string;
  private readonly controller = new AbortController();
  private readonly actionCapabilities: ReadonlySet<string>;
  private readonly declared: ReadonlyMap<string, ExecutablePluginCapability>;
  private readonly handlers = new Map<string, AnyHandler>();
  private readonly pending = new Set<AbortController>();
  private closedCode: PluginRuntimeFaultCode | undefined;
  private requests = 0;
  private observationId = 0;
  private removeExternalAbort?: () => void;

  constructor(private readonly options: PluginCapabilityBrokerOptions) {
    let manifest: ExecutablePluginManifest;
    // This is a trusted host parameter, not a raw Guest object. Take an owned,
    // validated snapshot so later mutation cannot widen the run's declarations.
    try { manifest = parseExecutablePluginManifest(JSON.stringify(options.manifest)); }
    catch { throw new PluginBrokerFault("invalid-input"); }
    this.manifestJson = JSON.stringify(manifest);
    const supplied = options.binding;
    if (!supplied || typeof supplied.sessionId !== "string" || !supplied.sessionId.trim() || supplied.sessionId.length > 512
      || typeof supplied.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(supplied.contentHash)
      || (supplied.scope !== "chat" && supplied.scope !== "workbench")
      || [supplied.grantRevision, supplied.sessionRevision, supplied.permissionRevision].some(revision => !Number.isSafeInteger(revision) || revision < 0)) denied("invalid-input");
    // Select explicitly: even an accidental extra field in a trusted host call is not forwarded.
    this.binding = own({ pluginId: supplied.pluginId, contentHash: supplied.contentHash, grantRevision: supplied.grantRevision,
      sessionId: supplied.sessionId, sessionRevision: supplied.sessionRevision, permissionRevision: supplied.permissionRevision,
      scope: supplied.scope, actionId: supplied.actionId });
    const action = manifest.actions.find((item) => item.id === this.binding.actionId);
    if (manifest.id !== this.binding.pluginId || (options.actionId !== undefined && options.actionId !== this.binding.actionId)
      || !action || (action.scope !== "both" && action.scope !== this.binding.scope)) denied("invalid-input");
    this.actionCapabilities = new Set(action.capabilities);
    this.declared = new Map(manifest.capabilities.map((cap) => [cap.name,
      cap.name === "network.request" ? own({ name: cap.name, origins: Object.freeze([...cap.origins]), methods: Object.freeze([...cap.methods]) }) : own({ name: cap.name }),
    ]));
    for (const name of EXECUTABLE_PLUGIN_CAPABILITY_NAMES) {
      if (Object.hasOwn(options.handlers, name) && typeof options.handlers[name] === "function") this.handlers.set(name, options.handlers[name] as AnyHandler);
    }
    if (options.signal) {
      const signal = options.signal, aborted = () => this.close("cancelled");
      signal.addEventListener("abort", aborted, { once: true });
      this.removeExternalAbort = () => signal.removeEventListener("abort", aborted);
      if (signal.aborted) aborted();
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }
  /** Service uses this before starting a run and before accepting its final result. */
  assertCurrent(): void { this.policy(); }
  invalidate(): void { this.close("revoked"); }
  dispose(): void { this.close("cancelled"); }
  private close(code: PluginRuntimeFaultCode): void {
    if (this.closedCode) return;
    this.closedCode = code;
    this.removeExternalAbort?.(); this.removeExternalAbort = undefined;
    this.controller.abort();
  }
  private policy(): PluginBrokerPolicy {
    if (this.closedCode) denied(this.closedCode);
    let current: PluginBrokerPolicy | null;
    try { current = this.options.current(); } catch { current = null; }
    if (!current || current.enabled !== true || BINDING_KEYS.some((key) => current[key] !== this.binding[key])
      || !["read-only", "workspace-edit", "full-access"].includes(current.permissionMode)
      || typeof current.planActive !== "boolean" || !Array.isArray(current.grantedCapabilities)) {
      this.close("revoked"); return denied("revoked");
    }
    return current;
  }
  private assertCapability(name: ExecutablePluginCapabilityName, args?: PluginCapabilityArguments[PluginBrokerCapability]): void {
    const current = this.policy(), declared = this.declared.get(name);
    const granted = current.grantedCapabilities.find((item) => item.name === name);
    if (!declared || !granted || !this.actionCapabilities.has(name)) denied("capability-denied");
    if (this.binding.scope === "chat" && WORKSPACE.has(name)) denied("capability-denied");
    if (MUTATING_WORKSPACE.has(name) && (current.planActive || current.permissionMode === "read-only")) denied("capability-denied");
    if (name === "network.request" && args) {
      if (declared.name !== "network.request" || granted.name !== "network.request") denied("capability-denied");
      const request = args as PluginCapabilityArguments["network.request"], origin = new URL(request.url).origin;
      if (this.binding.scope === "workbench" && (current.planActive || current.permissionMode === "read-only")) denied("capability-denied");
      if (!declared.origins.includes(origin) || !declared.methods.includes(request.method)
        || !granted.origins.includes(origin) || !granted.methods.includes(request.method)) denied("capability-denied");
    }
  }

  async call(capability: unknown, argsJson: unknown): Promise<PluginRunResult> {
    const requestId = ++this.observationId;
    const observedName = typeof capability === "string" && CAPABILITY_NAMES.has(capability) ? capability as ExecutablePluginCapabilityName : null;
    const observe = (phase: PluginBrokerObservation["phase"], code?: PluginRuntimeFaultCode) => {
      try { this.options.observe?.(Object.freeze({ requestId, capability: observedName, phase, ...(code ? { code } : {}) })); }
      catch { /* Observers cannot grant, deny or change capability execution. */ }
    };
    const observedResult = (result: PluginRunResult): PluginRunResult => { observe("settled", result.ok ? undefined : result.code); return result; };
    observe("requested");
    let name: ExecutablePluginCapabilityName, args: PluginCapabilityArguments[PluginBrokerCapability], handler: AnyHandler;
    try {
      this.assertCurrent();
      if (++this.requests > PLUGIN_RUNTIME_LIMITS.requests || this.pending.size >= PLUGIN_RUNTIME_LIMITS.pending) denied("resource-limit");
      if (typeof capability !== "string" || !CAPABILITY_NAMES.has(capability)) denied("capability-denied");
      name = capability as ExecutablePluginCapabilityName;
      this.assertCapability(name);
      const candidate = this.handlers.get(name);
      if (!candidate) denied("capability-denied");
      handler = candidate;
      try { args = argsFor(name, parsePluginJson(argsJson, PLUGIN_RUNTIME_LIMITS.argsBytes)); }
      catch (error) { if (error instanceof PluginBrokerFault) throw error; denied("invalid-input"); }
      this.assertCapability(name, args);
    } catch (error) { return observedResult(resultError(error)); }

    return new Promise<PluginRunResult>((resolve) => {
      const controller = new AbortController();
      this.pending.add(controller);
      let settled = false;
      const settle = (result: PluginRunResult): void => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        this.signal.removeEventListener("abort", onAbort);
        this.pending.delete(controller);
        controller.abort(); // A retained handler context cannot commit after this call has settled.
        resolve(result);
      };
      const onAbort = (): void => {
        controller.abort(); settle({ ok: false, code: this.closedCode ?? "cancelled" });
      };
      const timer = setTimeout(() => {
        controller.abort(); settle({ ok: false, code: "timeout" });
      }, CALL_TIMEOUT_MS);
      this.signal.addEventListener("abort", onAbort, { once: true });
      const context = own({ binding: this.binding, signal: controller.signal, assertCurrent: (): void => {
        if (controller.signal.aborted) denied(this.closedCode ?? "cancelled");
        this.assertCapability(name, args);
      } });
      try {
        context.assertCurrent();
        const value = handler(args, context);
        Promise.resolve(value).then((valueJson) => {
          if (settled) return;
          try {
            context.assertCurrent();
            try { parsePluginJson(valueJson, PLUGIN_RUNTIME_LIMITS.outputBytes); }
            catch { denied("invalid-message"); }
            settle({ ok: true, valueJson });
          } catch (error) { settle(resultError(error)); }
        }, (error) => {
          if (settled) return;
          try { context.assertCurrent(); settle(resultError(error)); }
          catch (currentError) { settle(resultError(currentError)); }
        });
      } catch (error) { settle(resultError(error)); }
    }).then(observedResult);
  }
}
