import {
  newQuickJSWASMModuleFromVariant, newVariant,
  type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime,
} from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import { parseExecutablePluginPackage, type ExecutablePluginCapabilityName } from "../../shared/executable-plugins.js";
import {
  PLUGIN_RUNTIME_LIMITS, PluginRuntimeFault, isPluginRunResult, parsePluginJson, validatePluginActionInput,
  type PluginCapabilityRequest, type PluginRunRequest, type PluginRunResult, type PluginRuntimeFaultCode,
} from "../../shared/plugin-runtime.js";

export interface PluginGuestRequest extends PluginRunRequest { wasmBinary: ArrayBuffer }
export interface PluginGuestBridge {
  readonly signal: AbortSignal;
  request(request: PluginCapabilityRequest): Promise<PluginRunResult>;
  onReady(): void;
  onPhase(busy: boolean): void;
}

const BOOTSTRAP_NAME = "herta:bootstrap";
// All code in this string is host-owned. Untrusted entry/export/input values are
// passed as Guest handles, never interpolated into either native or Guest code.
const BOOTSTRAP = `(() => {
  const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze;
  return [
    async entry => await import(entry),
    async (fn, input, api) => await fn(parse(input), api),
    value => stringify(value),
    raw => async value => parse(await raw(stringify(value === undefined ? null : value))),
    value => freeze(value),
    (object, key) => object[key]
  ];
})()`;

/** Resolve only relative imports from a frozen package; no Node/browser/host loader fallback. */
function resolveModule(base: string, specifier: string, files: ReadonlyMap<string, string>): string {
  if (specifier.length > 160 || /[\\:%?#\s]/.test(specifier)) throw new PluginRuntimeFault("module-denied");
  if (base === BOOTSTRAP_NAME && files.has(specifier)) return specifier;
  if (!files.has(base) || (!specifier.startsWith("./") && !specifier.startsWith("../"))) {
    throw new PluginRuntimeFault("module-denied");
  }
  const segments = base.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (!segments.length) throw new PluginRuntimeFault("module-denied");
      segments.pop();
    } else if (!part) throw new PluginRuntimeFault("module-denied");
    else segments.push(part);
  }
  const resolved = segments.join("/");
  if (!files.has(resolved)) throw new PluginRuntimeFault("module-denied");
  return resolved;
}

/**
 * Runs inside a trusted Worker, itself intended to live outside the main process.
 * QuickJS is the language boundary; Worker termination is the hard-timeout
 * fallback. This function cannot by itself hard-stop an uninterruptible native
 * call. The bridge owns run identity/authorization and never trusts Guest IDs.
 * Every SDK call, including log/progress, returns a Promise and must be awaited.
 * Returning with outstanding calls fails the run; fire-and-forget is unsupported.
 */
export async function runPluginGuest(request: PluginGuestRequest, bridge: PluginGuestBridge): Promise<PluginRunResult> {
  let bundle: ReturnType<typeof parseExecutablePluginPackage>;
  try { bundle = parseExecutablePluginPackage(request.packageJson); }
  catch { return { ok: false, code: "invalid-package" }; }
  const action = bundle.manifest.actions.find((item) => item.id === request.actionId);
  if (!action) return { ok: false, code: "invalid-input" };
  let inputJson: string;
  try { inputJson = validatePluginActionInput(action, request.inputJson); }
  catch { return { ok: false, code: "invalid-input" }; }
  if (!(request.wasmBinary instanceof ArrayBuffer) || request.wasmBinary.byteLength > 2 * 1024 * 1024) {
    return { ok: false, code: "runner-unavailable" };
  }
  if (bridge.signal.aborted) return { ok: false, code: "cancelled" };

  const files = new Map(bundle.files.map((file) => [file.path, file.source]));
  const fixedMemory = new WebAssembly.Memory({
    initial: PLUGIN_RUNTIME_LIMITS.memoryBytes / 65536,
    maximum: PLUGIN_RUNTIME_LIMITS.memoryBytes / 65536,
  });
  let moduleInstance: Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>> | undefined;
  try {
    // Emscripten supports these output callbacks; the wrapper's narrower type
    // omits them. Keep the extension local rather than weakening all options.
    const quietModule: NonNullable<Parameters<typeof newVariant>[1]["emscriptenModule"]>
      & { print(text: string): void; printErr(text: string): void } = { print: () => {}, printErr: () => {} };
    moduleInstance = await newQuickJSWASMModuleFromVariant(newVariant(releaseSync, {
      wasmBinary: request.wasmBinary,
      wasmMemory: fixedMemory,
      // Emscripten diagnostics must not stream unbounded Guest-triggered text.
      emscriptenModule: quietModule,
    }));
  } catch { return { ok: false, code: "runner-unavailable" }; }
  if (bridge.signal.aborted) return { ok: false, code: "cancelled" };
  if (moduleInstance.getWasmMemory() !== fixedMemory || fixedMemory.buffer.byteLength !== PLUGIN_RUNTIME_LIMITS.memoryBytes) {
    return { ok: false, code: "runner-unavailable" };
  }

  return await new Promise<PluginRunResult>((resolve) => {
    let vm: QuickJSContext | undefined, runtime: QuickJSRuntime | undefined;
    let stopped = false, guestDepth = 0, cpuRemaining: number = PLUGIN_RUNTIME_LIMITS.cpuMs;
    let interruptAt = Infinity, terminalCode: PluginRuntimeFaultCode | undefined, moduleDenied = false;
    let requestAttempts = 0, nextRequestId = 0, jobs = 0, stage: "module" | "action" = "module";
    let result: QuickJSHandle | undefined;
    let api: QuickJSHandle, importer: QuickJSHandle, invoke: QuickJSHandle, serialize: QuickJSHandle;
    let wrap: QuickJSHandle, freeze: QuickJSHandle, property: QuickJSHandle;
    let pumpTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const owned = new Set<QuickJSHandle>();
    const pending = new Map<number, QuickJSDeferredPromise>();
    const keep = (handle: QuickJSHandle): QuickJSHandle => { owned.add(handle); return handle; };
    const drop = (handle: QuickJSHandle): void => { owned.delete(handle); if (handle.alive) handle.dispose(); };
    const fault = (fallback: PluginRuntimeFaultCode): PluginRuntimeFaultCode =>
      bridge.signal.aborted ? "cancelled" : terminalCode ?? (moduleDenied && fallback === "guest-error" ? "module-denied" : fallback);
    const phase = (busy: boolean): void => {
      try { bridge.onPhase(busy); } catch { terminalCode = "host-error"; }
    };
    const guestCall = <T>(call: () => T): T => {
      const outer = guestDepth++ === 0;
      const start = performance.now();
      if (outer) { interruptAt = start + cpuRemaining; phase(true); }
      try { return call(); }
      finally {
        guestDepth--;
        if (outer) {
          cpuRemaining -= performance.now() - start;
          if (cpuRemaining <= 0) terminalCode ??= "resource-limit";
          phase(false);
        }
      }
    };
    const finish = (outcome: PluginRunResult): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(pumpTimer); clearTimeout(wallTimer);
      bridge.signal.removeEventListener("abort", onAbort);
      try {
        for (const deferred of pending.values()) deferred.dispose();
        pending.clear();
        for (const handle of owned) if (handle.alive) handle.dispose();
        owned.clear();
        vm?.dispose(); runtime?.dispose();
      } catch { outcome = { ok: false, code: "runner-crashed" }; }
      vm = undefined; runtime = undefined; moduleInstance = undefined;
      phase(false);
      resolve(outcome);
    };
    const onAbort = (): void => {
      // Never destroy a VM while inside a reentrant Guest callback.
      queueMicrotask(() => finish({ ok: false, code: "cancelled" }));
    };
    const assertRunning = (): void => {
      if (stopped || bridge.signal.aborted || terminalCode) throw new PluginRuntimeFault(fault("cancelled"));
    };
    const readPrimitiveString = (handle: QuickJSHandle, maximum: number): string => {
      // getLength in 0.32.0 does not accept primitive strings. Their own length
      // property is immutable; inspect it before copying any bytes into Node.
      if (!vm || vm.typeof(handle) !== "string") throw new PluginRuntimeFault("invalid-message");
      const lengthHandle = keep(vm.getProp(handle, "length"));
      const length = vm.getNumber(lengthHandle); drop(lengthHandle);
      if (!Number.isInteger(length) || length < 0 || length > maximum) throw new PluginRuntimeFault("resource-limit");
      const value = vm.getString(handle);
      if (new TextEncoder().encode(value).length > maximum) throw new PluginRuntimeFault("resource-limit");
      return value;
    };
    const checkedCall = (fn: QuickJSHandle, args: QuickJSHandle[]): QuickJSHandle => {
      assertRunning();
      const called = guestCall(() => vm!.callFunction(fn, vm!.undefined, args));
      if (called.error) { called.error.dispose(); throw new PluginRuntimeFault(fault("guest-error")); }
      return keep(called.value);
    };
    const schedulePump = (): void => {
      if (!stopped && !pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = undefined; pump(); }, 0);
    };
    const settle = (id: number, reply: PluginRunResult): void => {
      const deferred = pending.get(id);
      if (stopped || !vm || !deferred || bridge.signal.aborted) return;
      pending.delete(id);
      try {
        if (!isPluginRunResult(reply)) throw new PluginRuntimeFault("invalid-message");
        if (!reply.ok && (reply.code === "revoked" || reply.code === "cancelled")) {
          deferred.dispose(); finish(reply); return;
        }
        const value = keep(vm.newString(reply.ok ? reply.valueJson : reply.code));
        // These intrinsic promise resolvers receive only bounded host strings,
        // never Guest objects/thenables. Library-internal resolver unwrap is not
        // used for user eval results/errors (which are explicitly disposed).
        guestCall(() => reply.ok ? deferred.resolve(value) : deferred.reject(value));
        drop(value); deferred.dispose();
        if (terminalCode) finish({ ok: false, code: fault("resource-limit") });
        else schedulePump();
      } catch (error) {
        deferred.dispose();
        finish({ ok: false, code: error instanceof PluginRuntimeFault ? error.code : "host-error" });
      }
    };
    const makeCapability = (capability: ExecutablePluginCapabilityName): QuickJSHandle => {
      const raw = keep(vm!.newFunction(capability, (args) => {
        assertRunning();
        if (++requestAttempts > PLUGIN_RUNTIME_LIMITS.requests || pending.size >= PLUGIN_RUNTIME_LIMITS.pending) {
          terminalCode = "resource-limit";
          throw new Error("resource-limit");
        }
        let argsJson: string;
        try {
          if (!args) throw new PluginRuntimeFault("invalid-message");
          argsJson = readPrimitiveString(args, PLUGIN_RUNTIME_LIMITS.argsBytes);
          parsePluginJson(argsJson, PLUGIN_RUNTIME_LIMITS.argsBytes);
        } catch {
          throw new Error("invalid-message");
        }
        // Failed argument validation consumes quota, but not a transport ID:
        // the main service requires contiguous IDs for actually admitted calls.
        const id = ++nextRequestId, deferred = vm!.newPromise();
        pending.set(id, deferred);
        // Dispatch after leaving Guest execution. The capability is captured by
        // this trusted closure; no Guest-provided identity or capability name.
        void Promise.resolve().then(async () => {
          if (stopped || bridge.signal.aborted || !pending.has(id)) return;
          try { settle(id, await bridge.request({ id, capability, argsJson })); }
          catch { settle(id, { ok: false, code: "host-error" }); }
        });
        // QuickJS takes ownership of this returned handle; deferred retains its
        // resolver handles until settlement/disposal, not a second owned Promise.
        return deferred.handle;
      }));
      const wrapped = checkedCall(wrap, [raw]); drop(raw);
      return wrapped;
    };
    const pump = (): void => {
      if (stopped) return;
      try {
        assertRunning();
        if (!runtime || !vm || !result) throw new PluginRuntimeFault("runner-crashed");
        if (runtime.hasPendingJob()) {
          const allowance = Math.min(128, PLUGIN_RUNTIME_LIMITS.jobs - jobs);
          if (allowance <= 0) throw new PluginRuntimeFault("resource-limit");
          const executed = guestCall(() => runtime!.executePendingJobs(allowance));
          if (executed.error) { executed.error.dispose(); throw new PluginRuntimeFault(fault("guest-error")); }
          jobs += executed.value;
        }
        assertRunning();
        const state = vm.getPromiseState(result);
        if (state.type === "rejected") { state.error.dispose(); throw new PluginRuntimeFault(fault("guest-error")); }
        if (state.type === "fulfilled") {
          const value = state.notAPromise ? state.value : keep(state.value);
          if (stage === "module") {
            const exportName = keep(vm.newString(action.export));
            const exported = checkedCall(property, [value, exportName]); drop(exportName);
            if (vm.typeof(exported) !== "function") throw new PluginRuntimeFault("missing-export");
            const input = keep(vm.newString(inputJson));
            const next = checkedCall(invoke, [exported, input, api]);
            drop(input); drop(exported);
            if (!state.notAPromise) drop(value);
            drop(result); result = next; stage = "action";
            schedulePump(); return;
          }
          // An action must not claim completion while its requested operations
          // are unresolved. The outer service cancels the associated broker work.
          if (pending.size > 0) throw new PluginRuntimeFault("guest-error");
          const serialized = checkedCall(serialize, [value]);
          if (!state.notAPromise) drop(value);
          const valueJson = readPrimitiveString(serialized, PLUGIN_RUNTIME_LIMITS.outputBytes);
          parsePluginJson(valueJson, PLUGIN_RUNTIME_LIMITS.outputBytes);
          drop(serialized);
          finish({ ok: true, valueJson }); return;
        }
        // No Guest timers/native event sources are exposed. With no queued jobs,
        // only a broker settlement can make progress; settle() resumes the pump.
        // Leave idle runs asleep until that reply, abort or the wall deadline.
        if (runtime.hasPendingJob()) schedulePump();
      } catch (error) {
        finish({ ok: false, code: fault(error instanceof PluginRuntimeFault ? error.code : "guest-error") });
      }
    };

    bridge.signal.addEventListener("abort", onAbort, { once: true });
    wallTimer = setTimeout(() => finish({ ok: false, code: "timeout" }), PLUGIN_RUNTIME_LIMITS.wallMs);
    try {
      runtime = moduleInstance!.newRuntime();
      runtime.setMaxStackSize(256 * 1024);
      runtime.setInterruptHandler(() => {
        if (bridge.signal.aborted) return true;
        if (performance.now() >= interruptAt) { terminalCode = "resource-limit"; return true; }
        return false;
      });
      runtime.setModuleLoader((name) => {
        const source = files.get(name);
        if (source === undefined) { moduleDenied = true; throw new Error("module-denied"); }
        return source;
      }, (base, specifier) => {
        try { return resolveModule(base, specifier, files); }
        catch { moduleDenied = true; throw new Error("module-denied"); }
      });
      vm = runtime.newContext();
      bridge.onReady();
      const boot = guestCall(() => vm!.evalCode(BOOTSTRAP, BOOTSTRAP_NAME));
      if (boot.error) { boot.error.dispose(); throw new PluginRuntimeFault("runner-unavailable"); }
      const helpers = keep(boot.value);
      [importer, invoke, serialize, wrap, freeze, property] = Array.from({ length: 6 }, (_, index) => keep(vm!.getProp(helpers, index))) as [QuickJSHandle, QuickJSHandle, QuickJSHandle, QuickJSHandle, QuickJSHandle, QuickJSHandle];
      drop(helpers);
      api = keep(vm.newObject(vm.null));
      const namespaces = new Map<string, QuickJSHandle>();
      for (const capability of action.capabilities) {
        const [namespace, member] = capability.split(".");
        const wrapped = makeCapability(capability);
        let target = api;
        if (member) {
          target = namespaces.get(namespace!) ?? keep(vm.newObject(vm.null));
          if (!namespaces.has(namespace!)) { namespaces.set(namespace!, target); vm.setProp(api, namespace!, target); }
        }
        vm.setProp(target, member ?? namespace!, wrapped); drop(wrapped);
      }
      for (const namespace of namespaces.values()) drop(checkedCall(freeze, [namespace]));
      drop(checkedCall(freeze, [api]));
      const entry = keep(vm.newString(bundle.manifest.entry));
      result = checkedCall(importer, [entry]); drop(entry);
      schedulePump();
    } catch (error) {
      finish({ ok: false, code: fault(error instanceof PluginRuntimeFault ? error.code : "runner-crashed") });
    }
  });
}
