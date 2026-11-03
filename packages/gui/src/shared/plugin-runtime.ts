import type { ExecutablePluginAction, ExecutablePluginCapabilityName } from "./executable-plugins.js";

/** Host policy, never read from plugin manifests. WASM bytes are not a process RSS cap. */
export const PLUGIN_RUNTIME_LIMITS = Object.freeze({
  memoryBytes: 64 * 1024 * 1024, cpuMs: 1000, busyMs: 2000,
  wallMs: 300000, startupMs: 10000, inputBytes: 32768,
  argsBytes: 65536, outputBytes: 262144, requests: 64, pending: 8, jobs: 4096,
});
export const PLUGIN_RUNTIME_FAULT_CODES = Object.freeze([
  "invalid-input", "invalid-package", "missing-export", "module-denied", "guest-error",
  "resource-limit", "timeout", "cancelled", "revoked", "capability-denied", "invalid-message",
  "runner-unavailable", "runner-crashed", "host-error", "busy",
] as const);
export type PluginRuntimeFaultCode = typeof PLUGIN_RUNTIME_FAULT_CODES[number];
export type PluginRunResult = { ok: true; valueJson: string } | { ok: false; code: PluginRuntimeFaultCode };
export interface PluginRunRequest { packageJson: string; actionId: string; inputJson: string }
export interface PluginCapabilityRequest { id: number; capability: ExecutablePluginCapabilityName; argsJson: string }
export type PluginWorkerMessage = { kind: "ready" } | { kind: "phase"; busy: boolean }
  | ({ kind: "request" } & PluginCapabilityRequest) | { kind: "result"; result: PluginRunResult };
export type PluginWorkerReply = { kind: "reply"; id: number; result: PluginRunResult } | { kind: "cancel" };
export type PluginUtilityInput = { kind: "start"; request: PluginRunRequest } | PluginWorkerReply;
export type PluginJsonValue = null | string | number | boolean | readonly PluginJsonValue[] | { readonly [key: string]: PluginJsonValue };

export class PluginRuntimeFault extends Error {
  constructor(readonly code: PluginRuntimeFaultCode) { super(code); this.name = "PluginRuntimeFault"; }
}
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

/** Input is text only: no getters, Proxy or toJSON hooks from arbitrary host objects. */
export function parsePluginJson(text: unknown, maxBytes: number): PluginJsonValue {
  if (typeof text !== "string" || text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
    throw new PluginRuntimeFault("invalid-input");
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new PluginRuntimeFault("invalid-input"); }
  let count = 0;
  const own = (value: unknown, depth: number): PluginJsonValue => {
    if (++count > 8192 || depth > 12) throw new PluginRuntimeFault("invalid-input");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return Object.freeze(value.map(item => own(item, depth + 1)));
    if (value && typeof value === "object") {
      const result: Record<string, PluginJsonValue> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (forbidden.has(key)) throw new PluginRuntimeFault("invalid-input");
        result[key] = own(item, depth + 1);
      }
      return Object.freeze(result);
    }
    throw new PluginRuntimeFault("invalid-input");
  };
  return own(raw, 0);
}

/** Validates actual user input, independent of the manifest's default-definition check. */
export function validatePluginActionInput(action: ExecutablePluginAction, inputJson: unknown): string {
  const raw = parsePluginJson(inputJson, PLUGIN_RUNTIME_LIMITS.inputBytes);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PluginRuntimeFault("invalid-input");
  const values = raw as Record<string, PluginJsonValue>;
  if (Object.keys(values).some(key => !action.inputs.some(input => input.id === key))) throw new PluginRuntimeFault("invalid-input");
  const result: Record<string, PluginJsonValue> = Object.create(null);
  for (const input of action.inputs) {
    const value = Object.hasOwn(values, input.id) ? values[input.id] : input.default;
    if (value === undefined) {
      if (input.required) throw new PluginRuntimeFault("invalid-input");
      continue;
    }
    let valid = false;
    switch (input.type) {
      case "text": valid = typeof value === "string" && value.length <= input.maxLength && (!input.required || value.trim().length > 0); break;
      case "select": valid = typeof value === "string" && input.options.includes(value); break;
      case "number": valid = typeof value === "number" && Number.isFinite(value) && value >= input.min && value <= input.max && (!input.integer || Number.isSafeInteger(value)); break;
      case "boolean": valid = typeof value === "boolean"; break;
    }
    if (!valid) throw new PluginRuntimeFault("invalid-input");
    result[input.id] = value;
  }
  const encoded = JSON.stringify(result);
  // Many defaults together may exceed the total input budget.
  parsePluginJson(encoded, PLUGIN_RUNTIME_LIMITS.inputBytes);
  return encoded;
}

/** These envelopes come from structured-cloned trusted runners, never raw Guest objects. */
export function isPluginRunResult(raw: unknown): raw is PluginRunResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== 2) return false;
  if (r.ok === false) return typeof r.code === "string" && (PLUGIN_RUNTIME_FAULT_CODES as readonly string[]).includes(r.code);
  if (r.ok !== true || typeof r.valueJson !== "string") return false;
  try { parsePluginJson(r.valueJson, PLUGIN_RUNTIME_LIMITS.outputBytes); return true; } catch { return false; }
}
