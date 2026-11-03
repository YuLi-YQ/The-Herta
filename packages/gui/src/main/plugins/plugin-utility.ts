import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { isPluginRunResult, PLUGIN_RUNTIME_LIMITS, type PluginRuntimeFaultCode } from "../../shared/plugin-runtime.js";
import { EXECUTABLE_PLUGIN_LIMITS } from "../../shared/executable-plugins.js";

// Trusted utility process entry. Guest source goes only into its QuickJS Worker.
const port = process.parentPort;
let worker: Worker | undefined, started = false, finished = false;
let busy: ReturnType<typeof setTimeout> | undefined, wall: ReturnType<typeof setTimeout> | undefined;
const startup = setTimeout(() => fail("timeout"), PLUGIN_RUNTIME_LIMITS.startupMs);
function finish(result: unknown) {
  if (finished) return;
  finished = true; clearTimeout(startup); clearTimeout(busy); clearTimeout(wall);
  port?.postMessage({ kind: "result", result });
  void (worker?.terminate() ?? Promise.resolve()).finally(() => process.exit(0));
}
function fail(code: PluginRuntimeFaultCode) { finish({ ok: false, code }); }
if (!port) process.exit(1);
port.on("message", event => {
  if (finished) return;
  const message = event.data;
  if (!message || typeof message !== "object") return fail("invalid-message");
  if (message.kind === "cancel") return fail("cancelled");
  if (message.kind === "reply" && started && Number.isSafeInteger(message.id) && isPluginRunResult(message.result)) {
    worker?.postMessage(message); return;
  }
  if (message.kind !== "start" || started) return fail("invalid-message");
  const request = message.request;
  if (!request || typeof request.packageJson !== "string" || request.packageJson.length > EXECUTABLE_PLUGIN_LIMITS.jsonBytes || typeof request.actionId !== "string" || request.actionId.length > 64 || typeof request.inputJson !== "string" || request.inputJson.length > PLUGIN_RUNTIME_LIMITS.inputBytes) return fail("invalid-message");
  started = true;
  worker = new Worker(new URL("./plugin-guest-worker.js", import.meta.url), {
    workerData: { packageJson: request.packageJson, actionId: request.actionId, inputJson: request.inputJson, wasmPath: fileURLToPath(new URL("./plugin-quickjs.wasm", import.meta.url)) },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 }, stdout: true, stderr: true,
  });
  // Trusted runtime diagnostics are bounded/discarded; Guest logs use the broker.
  let diagnostics = 0;
  const discard = (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 65536) fail("resource-limit"); };
  worker.stdout.on("data", discard); worker.stderr.on("data", discard);
  worker.on("error", () => fail("runner-crashed"));
  worker.on("exit", () => { if (!finished) fail("runner-crashed"); });
  worker.on("message", raw => {
    if (finished) return;
    if (!raw || typeof raw !== "object") return fail("invalid-message");
    if (raw.kind === "ready") {
      clearTimeout(startup); wall = setTimeout(() => fail("timeout"), PLUGIN_RUNTIME_LIMITS.wallMs);
    } else if (raw.kind === "phase" && typeof raw.busy === "boolean") {
      if (raw.busy && !busy) busy = setTimeout(() => fail("resource-limit"), PLUGIN_RUNTIME_LIMITS.busyMs);
      if (!raw.busy) { clearTimeout(busy); busy = undefined; }
    } else if (raw.kind === "result") {
      if (!isPluginRunResult(raw.result)) return fail("invalid-message");
      return finish(raw.result);
    } else if (raw.kind !== "request") return fail("invalid-message");
    port.postMessage(raw);
  });
});
