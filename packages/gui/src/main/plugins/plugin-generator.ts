import { randomUUID } from "node:crypto";
import { desktopPersonaIdentity } from "@herta/app-server";
import { createProtocolAdapter, reasoningChoices, type ModelEvent, type ProviderConfig } from "@herta/providers";
import { acquireChatProvider, getProviderSettings } from "../provider-settings.js";
import { EXECUTABLE_PLUGIN_LIMITS, parseExecutablePluginPackage } from "../../shared/executable-plugins.js";
import { PLUGIN_AUTHORING_BRIEF_MAX, PLUGIN_AUTHORING_GUIDE } from "../../shared/plugin-authoring-guide.js";
import type { PluginStorageGuard } from "./plugin-storage-coordinator.js";

export interface PluginGeneratorInput {
  readonly requestId: string;
  readonly brief: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRevision: number;
  readonly reasoningEffort?: string;
  readonly previousPackageJson?: string;
}
export interface PluginGeneratorResult {
  readonly packageJson: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRevision: number;
  /** Captured model-text UTF8 bytes, including an optional outer JSON fence. */
  readonly outputBytes: number;
}
const MESSAGES = {
  invalid: "制作要求或模型选择无效，请检查后重试。",
  configuration: "所选模型尚未通过文本验证，或配置已变化；本次生成未采用。",
  cancelled: "制作目标已变化或生成已取消，本次结果未采用。",
  timeout: "插件生成超时，本次结果未采用。",
  provider: "模型未能完成插件生成，请检查连接或模型后重试。",
  incomplete: "模型未完整返回插件包，或请求了不支持的工具；本次结果未采用。",
  "invalid-package": "模型返回的内容不符合完整插件格式，请调整要求后重新生成。",
  "output-limit": "模型返回的插件内容超过大小限制，本次结果未采用。",
  busy: "已有插件正在生成，请先取消或等待完成。",
  disposed: "插件生成服务已关闭。",
} as const;
export type PluginGeneratorFaultReason = keyof typeof MESSAGES;
export class PluginGeneratorFault extends Error {
  constructor(readonly reason: PluginGeneratorFaultReason) { super(MESSAGES[reason]); this.name = "PluginGeneratorFault"; }
}
export interface PluginGeneratorDependencies {
  /** Trusted host/test dependencies only; never accepted from IPC or model output. */
  readonly acquire?: typeof acquireChatProvider;
  readonly readProvider?: (id: string) => ProviderConfig | undefined;
  readonly adapter?: typeof createProtocolAdapter;
  /** May shorten fixed production budgets for synthetic tests, never extend them. */
  readonly timings?: { readonly wallMs?: number; readonly pollMs?: number };
}
const WALL_MS = 180000, POLL_MS = 100, OUTPUT_BYTES = EXECUTABLE_PLUGIN_LIMITS.jsonBytes;
function fault(reason: PluginGeneratorFaultReason): never { throw new PluginGeneratorFault(reason); }
function validText(value: unknown, maximum: number, blank = false): value is string {
  if (typeof value !== "string" || value.length > maximum || (!blank && !value.trim()) || value.includes("\0")) return false;
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return true;
}
function captureInput(raw: PluginGeneratorInput): PluginGeneratorInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fault("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).some(key => typeof key !== "string"
    || !["requestId", "brief", "providerId", "modelId", "providerRevision", "reasoningEffort", "previousPackageJson"].includes(key)
    || !("value" in descriptors[key]!))) fault("invalid");
  const value = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
    || !validText(value.brief, PLUGIN_AUTHORING_BRIEF_MAX) || !validText(value.providerId, 256) || !validText(value.modelId, 256)
    || /[\x00-\x1f\x7f]/.test(value.providerId + value.modelId)
    || !Number.isSafeInteger(value.providerRevision) || value.providerRevision < 1
    || (value.reasoningEffort !== undefined && (!validText(value.reasoningEffort, 64) || /[\x00-\x1f\x7f]/.test(value.reasoningEffort)))
    || (value.previousPackageJson !== undefined && (!validText(value.previousPackageJson, EXECUTABLE_PLUGIN_LIMITS.jsonBytes, true)
      || Buffer.byteLength(value.previousPackageJson, "utf8") > EXECUTABLE_PLUGIN_LIMITS.jsonBytes))) fault("invalid");
  return Object.freeze(value) as unknown as PluginGeneratorInput;
}
function selectionCurrent(provider: ProviderConfig | undefined, input: PluginGeneratorInput): boolean {
  const model = provider?.models.find(item => item.id === input.modelId);
  return !!provider && provider.id === input.providerId && provider.revision === input.providerRevision && !!model
    && ["text-available", "tools-available"].includes(model.validation.state)
    && model.validation.providerRevision === provider.revision && model.validation.protocol === provider.protocol
    && (input.reasoningEffort === undefined || reasoningChoices(provider, input.modelId).includes(input.reasoningEffort));
}
function parseOutput(text: string): string {
  let json = text.trim();
  const fence = String.fromCharCode(96).repeat(3);
  if (json.startsWith(fence)) {
    const fenced = new RegExp("^" + fence + "json[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n" + fence + "[ \\t]*$", "i").exec(json);
    if (!fenced) fault("invalid-package");
    json = fenced[1]!;
  }
  try { return JSON.stringify(parseExecutablePluginPackage(json)); } catch { return fault("invalid-package"); }
}
function shorter(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) fault("invalid");
  return value;
}
/** Text generation only. It never writes files, reads chat/project data, executes
 * plugin source, installs packages or changes the user's role/model bindings. */
export function createPluginGenerator(deps: PluginGeneratorDependencies = {}) {
  const acquire = deps.acquire ?? acquireChatProvider;
  const readProvider = deps.readProvider ?? (id => getProviderSettings().settings.providers.find(provider => provider.id === id));
  const adapter = deps.adapter ?? createProtocolAdapter;
  const wallMs = shorter(deps.timings?.wallMs, WALL_MS), pollMs = shorter(deps.timings?.pollMs, POLL_MS);
  let disposed = false, active: AbortController | undefined;
  return {
    async generate(raw: PluginGeneratorInput, guard: PluginStorageGuard, progress?: (chars: number) => void): Promise<PluginGeneratorResult> {
      if (disposed) fault("disposed");
      if (active) fault("busy");
      const input = captureInput(raw);
      if (!guard || !(guard.signal instanceof AbortSignal) || typeof guard.assertCurrent !== "function") fault("invalid");
      const controller = new AbortController(); active = controller;
      let lease: ReturnType<typeof acquireChatProvider> | undefined, released = false;
      let iterator: AsyncIterator<ModelEvent> | undefined, iteratorEnded = false;
      let watcher: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort!: (cause: PluginGeneratorFault) => void;
      const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const stop = (reason: PluginGeneratorFaultReason) => {
        if (!controller.signal.aborted) controller.abort(new PluginGeneratorFault(reason));
      };
      const onStopped = () => rejectAbort(controller.signal.reason instanceof PluginGeneratorFault ? controller.signal.reason : new PluginGeneratorFault("cancelled"));
      controller.signal.addEventListener("abort", onStopped, { once: true });
      void stopped.catch(() => undefined);
      const externalAbort = () => stop("cancelled");
      guard.signal.addEventListener("abort", externalAbort, { once: true });
      let checkedAt = -Infinity;
      const assertCurrent = (force = false) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (disposed) fault("disposed");
        if (guard.signal.aborted) fault("cancelled");
        try { guard.assertCurrent(); } catch { fault("cancelled"); }
        if (!force && Date.now() - checkedAt < pollMs) return;
        let provider: ProviderConfig | undefined;
        try { provider = readProvider(input.providerId); } catch { fault("configuration"); }
        if (!selectionCurrent(provider, input)) fault("configuration");
        checkedAt = Date.now();
      };
      try {
        assertCurrent(true);
        try { lease = acquire(input.providerId, input.modelId); } catch { fault("configuration"); }
        if (!selectionCurrent(lease.config, input)) fault("configuration");
        assertCurrent(true);
        const started = Date.now();
        deadline = setTimeout(() => stop("timeout"), wallMs);
        watcher = setInterval(() => {
          try { assertCurrent(true); } catch (error) { stop(error instanceof PluginGeneratorFault ? error.reason : "configuration"); }
        }, pollMs);
        const collect = async (): Promise<PluginGeneratorResult> => {
          let text = "", outputBytes = 0, finished = false, events = 0;
          iterator = adapter(lease!.config, lease!.key).stream({
            sessionId: "herta-plugin-generator-" + input.requestId, turnId: randomUUID(), modelId: input.modelId,
            system: desktopPersonaIdentity("zh") + "\n\n" + PLUGIN_AUTHORING_GUIDE,
            messages: [{ role: "user", text: JSON.stringify({ brief: input.brief,
              ...(input.previousPackageJson === undefined ? {} : { previousPackageJson: input.previousPackageJson }) }) }],
            tools: [], options: { maxOutputTokens: 32768, webSearch: false, maxWebSearchUses: 0,
              ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) }, signal: controller.signal,
          })[Symbol.asyncIterator]();
          for (;;) {
            const next = await iterator.next(); assertCurrent();
            if (Date.now() - started >= wallMs) fault("timeout");
            if (next.done) { iteratorEnded = true; break; }
            const event = next.value;
            if (event.type === "tool-call-ready" || event.type === "tool-arguments-delta" || event.type === "web-search") fault("incomplete");
            if (event.type === "text-delta") {
              if (finished || typeof event.text !== "string") fault("incomplete");
              let bytes = Buffer.byteLength(event.text, "utf8");
              const last = text.charCodeAt(text.length - 1), first = event.text.charCodeAt(0);
              if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
              outputBytes += bytes; if (outputBytes > OUTPUT_BYTES) fault("output-limit");
              text += event.text;
              try { progress?.(text.length); } catch { /* Display observers do not decide success. */ }
            } else if (event.type === "finished") {
              if (finished || event.reason !== "stop") fault("incomplete"); finished = true;
            } else if (event.type === "public-reasoning-delta" && finished) fault("incomplete");
            if (++events % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
          }
          if (!finished || !text.trim()) fault("incomplete");
          assertCurrent(true);
          const packageJson = parseOutput(text); assertCurrent(true);
          return Object.freeze({ packageJson, providerId: input.providerId, modelId: input.modelId, providerRevision: input.providerRevision, outputBytes });
        };
        return await Promise.race([collect(), stopped]);
      } catch (error) {
        if (error instanceof PluginGeneratorFault) throw error;
        if (controller.signal.aborted) throw controller.signal.reason instanceof PluginGeneratorFault ? controller.signal.reason : new PluginGeneratorFault("cancelled");
        throw new PluginGeneratorFault("provider");
      } finally {
        clearInterval(watcher); clearTimeout(deadline);
        guard.signal.removeEventListener("abort", externalAbort);
        controller.signal.removeEventListener("abort", onStopped);
        stop("cancelled");
        if (iterator && !iteratorEnded) {
          try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Best effort after abort. */ }
        }
        if (lease && !released) { released = true; try { lease.release(); } catch { /* Never expose cleanup exceptions or replace a completed result. */ } }
        if (active === controller) active = undefined;
      }
    },
    dispose(): void { disposed = true; active?.abort(new PluginGeneratorFault("disposed")); },
  };
}
