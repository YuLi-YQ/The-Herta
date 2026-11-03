import { createHash, randomUUID } from "node:crypto";
import { parseExecutablePluginPackage, EXECUTABLE_PLUGIN_CAPABILITY_NAMES, type ExecutablePluginPackage } from "../../shared/executable-plugins.js";
import { isPluginRunResult, parsePluginJson, PLUGIN_RUNTIME_LIMITS, PluginRuntimeFault, validatePluginActionInput, type PluginRunRequest, type PluginRunResult, type PluginRuntimeFaultCode, type PluginUtilityInput } from "../../shared/plugin-runtime.js";
import { PluginBrokerFault, type PluginCapabilityBroker } from "./capability-broker.js";

/** Only a trusted Electron adapter implements this; no plugin path or IPC channel is accepted. */
export interface PluginProcess {
  postMessage(message: PluginUtilityInput): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  kill(): boolean;
}
export interface PluginTask {
  readonly id: string;
  /** The start message was posted successfully without synchronous termination; never changes after return. */
  readonly accepted: boolean;
  readonly result: Promise<PluginRunResult>;
  /** Resolves only after this run's process exits; an immediate rejection has no process. */
  readonly closed: Promise<void>;
  cancel(): void;
}
export function executablePluginPackageHash(pkg: ExecutablePluginPackage): string {
  return createHash("sha256").update(JSON.stringify(pkg), "utf8").digest("hex");
}
interface LiveRun { stop(code: PluginRuntimeFaultCode): void }
interface Options {
  createProcess(): PluginProcess;
  /** Host-only test/embedding policy, not accepted from renderer/manifest. */
  deadlines?: { startupMs?: number; wallMs?: number; busyMs?: number; pollMs?: number };
}

/** Per-run process, bounded concurrency, exact-once terminal result; no restart/replay. */
export class PluginRuntimeService {
  private runs = new Map<string, LiveRun>();
  private disposed = false;
  constructor(private readonly options: Options) {}
  get activeCount(): number { return this.runs.size; }
  start(request: PluginRunRequest, broker: PluginCapabilityBroker): PluginTask {
    const id = randomUUID();
    const immediate = (code: PluginRuntimeFaultCode): PluginTask => {
      broker.dispose(); return { id, accepted: false, result: Promise.resolve({ ok: false, code }), closed: Promise.resolve(), cancel() {} };
    };
    if (this.disposed) return immediate("runner-unavailable");
    if (this.runs.size >= 2) return immediate("busy");
    let normalized: PluginRunRequest;
    try {
      broker.assertCurrent();
      const pkg = parseExecutablePluginPackage(request.packageJson);
      const action = pkg.manifest.actions.find(item => item.id === request.actionId);
      if (!action || pkg.manifest.id !== broker.binding.pluginId || request.actionId !== broker.binding.actionId || executablePluginPackageHash(pkg) !== broker.binding.contentHash
        || JSON.stringify(pkg.manifest) !== broker.manifestJson) return immediate("revoked");
      normalized = { packageJson: JSON.stringify(pkg), actionId: action.id, inputJson: validatePluginActionInput(action, request.inputJson) };
    } catch (error) { return immediate(error instanceof PluginRuntimeFault || error instanceof PluginBrokerFault ? error.code : "invalid-package"); }

    let child: PluginProcess;
    try { child = this.options.createProcess(); }
    catch { return immediate("runner-unavailable"); }
    let resolveResult!: (result: PluginRunResult) => void;
    const result = new Promise<PluginRunResult>(resolve => { resolveResult = resolve; });
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let ended = false, ready = false, latestRequest = 0, inFlight = 0;
    let startup: ReturnType<typeof setTimeout> | undefined, wall: ReturnType<typeof setTimeout> | undefined, busy: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (value: PluginRunResult, exited = false) => {
      if (ended) { if (exited) this.runs.delete(id); return; }
      ended = true;
      clearTimeout(startup); clearTimeout(wall); clearTimeout(busy); clearInterval(poll);
      broker.signal.removeEventListener("abort", abort);
      broker.dispose();
      // Keep the concurrency slot until Electron actually reports exit, even if kill() fails.
      if (exited) this.runs.delete(id);
      else { try { child.kill(); } catch { /* A later exit still owns slot release. */ } }
      resolveResult(value);
    };
    const fault = (code: PluginRuntimeFaultCode) => finish({ ok: false, code });
    const abort = () => fault("revoked");
    this.runs.set(id, { stop: fault });
    child.on("exit", () => { finish({ ok: false, code: "runner-crashed" }, true); resolveClosed(); });
    child.on("message", raw => {
      if (ended) return;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fault("invalid-message");
      const message = raw as Record<string, unknown>;
      if (message.kind === "ready" && Object.keys(message).length === 1 && !ready) {
        ready = true; clearTimeout(startup);
        wall = setTimeout(() => fault("timeout"), this.options.deadlines?.wallMs ?? PLUGIN_RUNTIME_LIMITS.wallMs);
        return;
      }
      if (message.kind === "result" && Object.keys(message).length === 2 && isPluginRunResult(message.result) && (ready || !message.result.ok)) {
        try { broker.assertCurrent(); } catch { return fault("revoked"); }
        return finish(message.result);
      }
      if (!ready) return fault("invalid-message");
      if (message.kind === "phase" && Object.keys(message).length === 2 && typeof message.busy === "boolean") {
        // Repeated "busy" cannot reset a running watchdog.
        if (message.busy && !busy) busy = setTimeout(() => fault("resource-limit"), this.options.deadlines?.busyMs ?? PLUGIN_RUNTIME_LIMITS.busyMs);
        if (!message.busy) { clearTimeout(busy); busy = undefined; }
        return;
      }
      if (message.kind === "request" && Object.keys(message).length === 4 && Number.isSafeInteger(message.id) && (message.id as number) === latestRequest + 1
        && typeof message.capability === "string" && (EXECUTABLE_PLUGIN_CAPABILITY_NAMES as readonly string[]).includes(message.capability) && typeof message.argsJson === "string") {
        if (latestRequest >= PLUGIN_RUNTIME_LIMITS.requests || inFlight >= PLUGIN_RUNTIME_LIMITS.pending) return fault("resource-limit");
        try { parsePluginJson(message.argsJson, PLUGIN_RUNTIME_LIMITS.argsBytes); } catch { return fault("invalid-message"); }
        const requestId = message.id as number; latestRequest = requestId; inFlight++;
        void broker.call(message.capability, message.argsJson).then(reply => {
          inFlight--;
          if (ended) return;
          if (!isPluginRunResult(reply)) return fault("invalid-message");
          try { broker.assertCurrent(); child.postMessage({ kind: "reply", id: requestId, result: reply }); }
          catch { fault("revoked"); }
        }, () => fault("host-error"));
        return;
      }
      fault("invalid-message");
    });
    broker.signal.addEventListener("abort", abort, { once: true });
    startup = setTimeout(() => fault("timeout"), this.options.deadlines?.startupMs ?? PLUGIN_RUNTIME_LIMITS.startupMs);
    poll = setInterval(() => { try { broker.assertCurrent(); } catch { fault("revoked"); } }, this.options.deadlines?.pollMs ?? 100);
    let posted = false;
    try { broker.assertCurrent(); child.postMessage({ kind: "start", request: normalized }); posted = true; }
    catch { fault("runner-unavailable"); }
    // Capture admission now. An asynchronous startup/guest failure must not make a
    // caller retry a request whose side effects may already have started.
    const accepted = posted && !ended;
    return { id, accepted, result, closed, cancel: () => fault("cancelled") };
  }
  dispose(): void { this.disposed = true; for (const run of this.runs.values()) run.stop("cancelled"); }
}
