/**
 * Data contract for local v2 JavaScript plugin packages. These declarations are
 * requests, never grants. No code is compiled, loaded or executed by this module.
 *
 * Public parsers accept JSON text only. Inspecting an arbitrary JS object (even
 * via descriptors) can invoke Proxy traps; rejecting objects before reflection
 * keeps getters, toJSON and prototype hooks outside this boundary entirely.
 */
export const EXECUTABLE_PLUGIN_LIMITS = Object.freeze({
  jsonBytes: 2 * 1024 * 1024,
  manifestBytes: 128 * 1024,
  jsonDepth: 16,
  jsonSeparators: 8192,
  modules: 32,
  moduleBytes: 256 * 1024,
  totalSourceBytes: 1024 * 1024,
  modulePathLength: 160,
  actions: 24,
  inputsPerAction: 16,
  textInputLength: 16000,
  networkOrigins: 16,
});

export const EXECUTABLE_PLUGIN_CAPABILITY_NAMES = Object.freeze([
  "workspace.readText", "workspace.proposePatch", "commands.run",
  "network.request", "storage.get", "storage.set", "draft.append",
  "ui.present", "ui.update", "artifacts.create", "log", "progress",
] as const);
export type ExecutablePluginCapabilityName = typeof EXECUTABLE_PLUGIN_CAPABILITY_NAMES[number];
export type ExecutablePluginScope = "chat" | "workbench" | "both";
export type ExecutablePluginHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type ExecutablePluginCapability =
  | Readonly<{ name: Exclude<ExecutablePluginCapabilityName, "network.request"> }>
  | Readonly<{ name: "network.request"; origins: readonly string[]; methods: readonly ExecutablePluginHttpMethod[] }>;

interface InputBase { readonly id: string; readonly label: string; readonly required: boolean }
export type ExecutablePluginInput =
  | Readonly<InputBase & { type: "text"; maxLength: number; default?: string }>
  | Readonly<InputBase & { type: "select"; options: readonly string[]; default?: string }>
  | Readonly<InputBase & { type: "number"; min: number; max: number; integer: boolean; default?: number }>
  | Readonly<InputBase & { type: "boolean"; default?: boolean }>;
export interface ExecutablePluginAction {
  readonly id: string;
  readonly title: string;
  readonly scope: ExecutablePluginScope;
  /** A Guest module export name. Consumers must use property lookup, not code interpolation. */
  readonly export: string;
  readonly inputs: readonly ExecutablePluginInput[];
  readonly capabilities: readonly ExecutablePluginCapabilityName[];
}
export interface ExecutablePluginManifest {
  readonly schemaVersion: 2;
  readonly apiVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly entry: string;
  readonly capabilities: readonly ExecutablePluginCapability[];
  readonly actions: readonly ExecutablePluginAction[];
}
export interface ExecutablePluginModule { readonly path: string; readonly source: string }
/** Portable JSON import representation; future directory/ZIP importers must produce this same form. */
export interface ExecutablePluginPackage {
  readonly manifest: ExecutablePluginManifest;
  readonly files: readonly ExecutablePluginModule[];
}

export type ExecutablePluginFaultCode = "invalid-json" | "invalid-type" | "unsupported-field"
  | "unsupported-version" | "limit-exceeded" | "invalid-value" | "duplicate" | "missing-file";
const FAULT_MESSAGES: Record<ExecutablePluginFaultCode, string> = {
  "invalid-json": "需要有效且没有重复字段的 JSON。",
  "invalid-type": "字段类型不符合插件格式。",
  "unsupported-field": "包含不支持的字段。",
  "unsupported-version": "不支持此插件格式或接口版本。",
  "limit-exceeded": "插件内容超过允许的大小或数量。",
  "invalid-value": "字段值不符合插件格式。",
  duplicate: "插件中的标识或路径重复。",
  "missing-file": "插件入口没有对应的模块文件。",
};
/** Diagnostics contain only fixed field paths/indices, never the supplied source or values. */
export class ExecutablePluginFault extends Error {
  constructor(readonly code: ExecutablePluginFaultCode, readonly path = "$") {
    super(`${path}：${FAULT_MESSAGES[code]}`);
    this.name = "ExecutablePluginFault";
  }
}
function fail(code: ExecutablePluginFaultCode, path: string): never {
  throw new ExecutablePluginFault(code, path);
}
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CAPABILITIES = new Set<string>(EXECUTABLE_PLUGIN_CAPABILITY_NAMES);
const WORKBENCH_CAPABILITIES = new Set<string>(["workspace.readText", "workspace.proposePatch", "commands.run"]);
const HTTP_METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const INPUT_ID = /^[a-z][a-z0-9_]*$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Count before allocating buffers; reject unpaired surrogates rather than silently rewriting source. */
function utf8Bytes(text: string, maximum: number, path: string): number {
  if (text.length > maximum) fail("limit-exceeded", path);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("invalid-value", path);
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail("invalid-value", path);
    else bytes += 3;
    if (bytes > maximum) fail("limit-exceeded", path);
  }
  return bytes;
}

/** Preflight the bounded JSON text, preserving duplicate keys before JSON.parse would discard them. */
function parseText(raw: unknown, maximum: number): unknown {
  if (typeof raw !== "string") fail("invalid-type", "$");
  utf8Bytes(raw, maximum, "$");
  const frames: { kind: "object" | "array"; keys: Set<string>; expectingKey: boolean }[] = [];
  let separators = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      const start = i;
      let closed = false;
      while (++i < raw.length) {
        if (raw[i] === "\\") i++;
        else if (raw[i] === '"') { closed = true; break; }
      }
      if (!closed) fail("invalid-json", "$");
      const frame = frames[frames.length - 1];
      if (frame?.kind === "object" && frame.expectingKey) {
        if (i - start > 256) fail("limit-exceeded", "$");
        let key: string;
        try { key = JSON.parse(raw.slice(start, i + 1)) as string; }
        catch { fail("invalid-json", "$"); }
        if (FORBIDDEN_KEYS.has(key)) fail("unsupported-field", "$");
        if (frame.keys.has(key)) fail("duplicate", "$");
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    } else if (c === "{" || c === "[") {
      frames.push({ kind: c === "{" ? "object" : "array", keys: new Set(), expectingKey: c === "{" });
      if (frames.length > EXECUTABLE_PLUGIN_LIMITS.jsonDepth) fail("limit-exceeded", "$");
    } else if (c === "}" || c === "]") {
      const frame = frames.pop();
      if (!frame || (c === "}" ? frame.kind !== "object" : frame.kind !== "array")) fail("invalid-json", "$");
    } else if (c === ",") {
      if (++separators > EXECUTABLE_PLUGIN_LIMITS.jsonSeparators) fail("limit-exceeded", "$");
      const frame = frames[frames.length - 1];
      if (frame?.kind === "object") frame.expectingKey = true;
    }
  }
  if (frames.length) fail("invalid-json", "$");
  try { return JSON.parse(raw); }
  catch { fail("invalid-json", "$"); }
}

// Only called on parser-owned JSON data, never on objects supplied by a caller.
function record(raw: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid-type", path);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("unsupported-field", path);
  return value;
}
function own<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, value));
}
function text(raw: unknown, maximum: number, path: string, empty = false): string {
  if (typeof raw !== "string") fail("invalid-type", path);
  if (raw.length > maximum) fail("limit-exceeded", path);
  utf8Bytes(raw, maximum * 4, path);
  if ((!empty && !raw.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) fail("invalid-value", path);
  return raw;
}
function identifier(raw: unknown, maximum: number, path: string, pattern = ID): string {
  const value = text(raw, maximum, path);
  if (!pattern.test(value) || FORBIDDEN_KEYS.has(value)) fail("invalid-value", path);
  return value;
}
function bool(raw: unknown, path: string): boolean {
  if (typeof raw !== "boolean") fail("invalid-type", path);
  return raw;
}
function finiteNumber(raw: unknown, path: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) fail("invalid-type", path);
  if (Math.abs(raw) > Number.MAX_SAFE_INTEGER) fail("invalid-value", path);
  return Object.is(raw, -0) ? 0 : raw;
}
function array(raw: unknown, minimum: number, maximum: number, path: string): unknown[] {
  if (!Array.isArray(raw)) fail("invalid-type", path);
  if (raw.length < minimum || raw.length > maximum) fail("limit-exceeded", path);
  return raw;
}
function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail("duplicate", path);
}
function modulePath(raw: unknown, path: string): string {
  const value = text(raw, EXECUTABLE_PLUGIN_LIMITS.modulePathLength, path);
  const segments = value.split("/");
  if (segments.length > 8 || !/\.(?:js|mjs)$/.test(value)) fail("invalid-value", path);
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.endsWith(".")
      || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)) fail("invalid-value", path);
  }
  return value;
}
function capabilityName(raw: unknown, path: string): ExecutablePluginCapabilityName {
  if (typeof raw !== "string" || !CAPABILITIES.has(raw)) fail("invalid-value", path);
  return raw as ExecutablePluginCapabilityName;
}
function capability(raw: unknown, path: string): ExecutablePluginCapability {
  const item = record(raw, ["name", "origins", "methods"], path);
  const name = capabilityName(item.name, `${path}.name`);
  if (name !== "network.request") {
    record(raw, ["name"], path);
    return own({ name });
  }
  const origins = array(item.origins, 1, EXECUTABLE_PLUGIN_LIMITS.networkOrigins, `${path}.origins`).map((rawOrigin, index) => {
    const location = `${path}.origins[${index}]`;
    const origin = text(rawOrigin, 256, location);
    let url: URL;
    try { url = new URL(origin); } catch { fail("invalid-value", location); }
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || origin.includes("*")) fail("invalid-value", location);
    return origin;
  });
  unique(origins, `${path}.origins`);
  const methods = array(item.methods, 1, HTTP_METHODS.size, `${path}.methods`).map((method, index) => {
    if (typeof method !== "string" || !HTTP_METHODS.has(method)) fail("invalid-value", `${path}.methods[${index}]`);
    return method as ExecutablePluginHttpMethod;
  });
  unique(methods, `${path}.methods`);
  return own({ name, origins: Object.freeze(origins.sort()), methods: Object.freeze(methods.sort()) });
}

function input(raw: unknown, path: string): ExecutablePluginInput {
  const value = record(raw, ["id", "label", "type", "required", "default", "maxLength", "options", "min", "max", "integer"], path);
  const base = { id: identifier(value.id, 40, `${path}.id`, INPUT_ID), label: text(value.label, 80, `${path}.label`), required: bool(value.required, `${path}.required`) };
  const common = ["id", "label", "type", "required", "default"];
  if (value.type === "text") {
    record(raw, [...common, "maxLength"], path);
    const maxLength = finiteNumber(value.maxLength, `${path}.maxLength`);
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > EXECUTABLE_PLUGIN_LIMITS.textInputLength) fail("invalid-value", `${path}.maxLength`);
    const defaultValue = value.default === undefined ? undefined : text(value.default, maxLength, `${path}.default`, !base.required);
    return own({ ...base, type: "text", maxLength, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
  }
  if (value.type === "select") {
    record(raw, [...common, "options"], path);
    const options = array(value.options, 1, 32, `${path}.options`).map((option, index) => text(option, 200, `${path}.options[${index}]`));
    unique(options, `${path}.options`);
    const defaultValue = value.default === undefined ? undefined : text(value.default, 200, `${path}.default`);
    if (defaultValue !== undefined && !options.includes(defaultValue)) fail("invalid-value", `${path}.default`);
    return own({ ...base, type: "select", options: Object.freeze(options), ...(defaultValue === undefined ? {} : { default: defaultValue }) });
  }
  if (value.type === "number") {
    record(raw, [...common, "min", "max", "integer"], path);
    const min = finiteNumber(value.min, `${path}.min`), max = finiteNumber(value.max, `${path}.max`);
    const integer = bool(value.integer, `${path}.integer`);
    if (min > max || (integer && (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)))) fail("invalid-value", path);
    const defaultValue = value.default === undefined ? undefined : finiteNumber(value.default, `${path}.default`);
    if (defaultValue !== undefined && (defaultValue < min || defaultValue > max || (integer && !Number.isSafeInteger(defaultValue)))) fail("invalid-value", `${path}.default`);
    return own({ ...base, type: "number", min, max, integer, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
  }
  if (value.type === "boolean") {
    record(raw, common, path);
    const defaultValue = value.default === undefined ? undefined : bool(value.default, `${path}.default`);
    return own({ ...base, type: "boolean", ...(defaultValue === undefined ? {} : { default: defaultValue }) });
  }
  return fail("invalid-value", `${path}.type`);
}

function manifest(raw: unknown, path: string): ExecutablePluginManifest {
  const value = record(raw, ["schemaVersion", "apiVersion", "id", "name", "version", "description", "entry", "capabilities", "actions"], path);
  if (value.schemaVersion !== 2) fail("unsupported-version", `${path}.schemaVersion`);
  if (value.apiVersion !== 1) fail("unsupported-version", `${path}.apiVersion`);
  const id = identifier(value.id, 80, `${path}.id`);
  if (id.length < 3) fail("invalid-value", `${path}.id`);
  const name = text(value.name, 80, `${path}.name`), description = text(value.description, 500, `${path}.description`, true);
  const version = text(value.version, 40, `${path}.version`);
  if (!/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version)) fail("invalid-value", `${path}.version`);
  const entry = modulePath(value.entry, `${path}.entry`);
  const capabilities = array(value.capabilities, 0, CAPABILITIES.size, `${path}.capabilities`).map((item, index) => capability(item, `${path}.capabilities[${index}]`));
  unique(capabilities.map((item) => item.name), `${path}.capabilities`);
  const requested = new Set(capabilities.map((item) => item.name));
  const used = new Set<string>();
  const actions = array(value.actions, 1, EXECUTABLE_PLUGIN_LIMITS.actions, `${path}.actions`).map((rawAction, index): ExecutablePluginAction => {
    const location = `${path}.actions[${index}]`;
    const action = record(rawAction, ["id", "title", "scope", "export", "inputs", "capabilities"], location);
    const actionId = identifier(action.id, 64, `${location}.id`), title = text(action.title, 80, `${location}.title`);
    if (action.scope !== "chat" && action.scope !== "workbench" && action.scope !== "both") fail("invalid-value", `${location}.scope`);
    const exportName = identifier(action.export, 80, `${location}.export`, EXPORT_NAME);
    const inputs = array(action.inputs, 0, EXECUTABLE_PLUGIN_LIMITS.inputsPerAction, `${location}.inputs`).map((item, inputIndex) => input(item, `${location}.inputs[${inputIndex}]`));
    unique(inputs.map((item) => item.id), `${location}.inputs`);
    const actionCapabilities = array(action.capabilities, 0, CAPABILITIES.size, `${location}.capabilities`).map((item, capabilityIndex) => {
      const capLocation = `${location}.capabilities[${capabilityIndex}]`, cap = capabilityName(item, capLocation);
      if (!requested.has(cap) || (action.scope !== "workbench" && WORKBENCH_CAPABILITIES.has(cap))) fail("invalid-value", capLocation);
      used.add(cap);
      return cap;
    });
    unique(actionCapabilities, `${location}.capabilities`);
    return own({ id: actionId, title, scope: action.scope, export: exportName, inputs: Object.freeze(inputs), capabilities: Object.freeze(actionCapabilities.sort()) });
  });
  unique(actions.map((item) => item.id), `${path}.actions`);
  if (capabilities.some((item) => !used.has(item.name))) fail("invalid-value", `${path}.capabilities`);
  return own({ schemaVersion: 2, apiVersion: 1, id, name, version, description, entry,
    capabilities: Object.freeze(capabilities.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), actions: Object.freeze(actions) });
}

/** Parse a standalone manifest preview. Does not assert that its module/export exists. */
export function parseExecutablePluginManifest(json: unknown): ExecutablePluginManifest {
  return manifest(parseText(json, EXECUTABLE_PLUGIN_LIMITS.manifestBytes), "$");
}
/** Parse/freeze a complete package; module contents are inert strings, never inspected as host code. */
export function parseExecutablePluginPackage(json: unknown): ExecutablePluginPackage {
  const value = record(parseText(json, EXECUTABLE_PLUGIN_LIMITS.jsonBytes), ["manifest", "files"], "$");
  const parsedManifest = manifest(value.manifest, "$.manifest");
  // Keep the standalone and bundled manifest size contracts identical.
  utf8Bytes(JSON.stringify(value.manifest), EXECUTABLE_PLUGIN_LIMITS.manifestBytes, "$.manifest");
  let sourceBytes = 0;
  const files = array(value.files, 1, EXECUTABLE_PLUGIN_LIMITS.modules, "$.files").map((rawFile, index) => {
    const location = `$.files[${index}]`, file = record(rawFile, ["path", "source"], location);
    const path = modulePath(file.path, `${location}.path`);
    if (typeof file.source !== "string") fail("invalid-type", `${location}.source`);
    sourceBytes += utf8Bytes(file.source, EXECUTABLE_PLUGIN_LIMITS.moduleBytes, `${location}.source`);
    if (sourceBytes > EXECUTABLE_PLUGIN_LIMITS.totalSourceBytes) fail("limit-exceeded", "$.files");
    return own({ path, source: file.source });
  });
  const portablePaths = files.map((file) => file.path.toLowerCase()).sort();
  unique(portablePaths, "$.files");
  const pathSet = new Set(portablePaths);
  for (const path of portablePaths) {
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end++) {
      if (pathSet.has(segments.slice(0, end).join("/"))) fail("invalid-value", "$.files");
    }
  }
  if (!files.some((file) => file.path === parsedManifest.entry)) fail("missing-file", "$.manifest.entry");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return own({ manifest: parsedManifest, files: Object.freeze(files) });
}

/** Stable host namespace; do not register bare action IDs into the existing tool registry. */
export function executablePluginActionKey(pluginId: string, actionId: string): string {
  const plugin = identifier(pluginId, 80, "$.id"), action = identifier(actionId, 64, "$.actionId");
  if (plugin.length < 3) fail("invalid-value", "$.id");
  return `herta.plugin.v2:${plugin}:${action}`;
}
