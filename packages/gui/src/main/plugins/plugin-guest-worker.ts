import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { runPluginGuest } from "./quickjs-runtime.js";
import {
  isPluginRunResult, type PluginCapabilityRequest, type PluginRunResult, type PluginWorkerMessage,
} from "../../shared/plugin-runtime.js";

// Fixed 0.32.0 release-sync asset, supplied only by the trusted utility runner.
// This prevents silently loading a different engine under the validated policy.
const WASM_BYTES = 503134;
const WASM_SHA256 = "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232";
const controller = new AbortController();
const pending = new Map<number, (reply: PluginRunResult) => void>();
let stopped = false;

function send(message: PluginWorkerMessage): void {
  if (!stopped) parentPort?.postMessage(message);
}
function stop(): void {
  controller.abort();
  for (const resolve of pending.values()) resolve({ ok: false, code: "cancelled" });
  pending.clear();
}
async function readEngine(path: unknown): Promise<ArrayBuffer> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("runner-unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(WASM_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== WASM_BYTES) throw new Error("runner-unavailable");
    const asset = bytes.subarray(0, length);
    if (createHash("sha256").update(asset).digest("hex") !== WASM_SHA256) throw new Error("runner-unavailable");
    return Uint8Array.from(asset).buffer;
  } finally { await file.close(); }
}

parentPort?.on("message", (message: unknown) => {
  if (stopped || !message || typeof message !== "object" || Array.isArray(message)) return;
  const value = message as Record<string, unknown>;
  if (value.kind === "cancel" && Object.keys(value).length === 1) { stop(); return; }
  if (value.kind !== "reply" || Object.keys(value).length !== 3 || !Number.isSafeInteger(value.id) || !isPluginRunResult(value.result)) {
    stop(); return;
  }
  const resolve = pending.get(value.id as number);
  if (!resolve) return; // A late/already-consumed reply cannot touch a new run.
  pending.delete(value.id as number);
  resolve(value.result);
});
parentPort?.on("close", stop);

async function main(): Promise<void> {
  let result: PluginRunResult;
  try {
    if (!parentPort || !workerData || typeof workerData !== "object" || Array.isArray(workerData)) throw new Error("invalid-message");
    const data = workerData as Record<string, unknown>;
    if (Object.keys(data).length !== 4 || typeof data.packageJson !== "string" || typeof data.actionId !== "string" || typeof data.inputJson !== "string") throw new Error("invalid-message");
    const wasmBinary = await readEngine(data.wasmPath);
    result = await runPluginGuest({ packageJson: data.packageJson, actionId: data.actionId, inputJson: data.inputJson, wasmBinary }, {
      signal: controller.signal,
      onReady: () => send({ kind: "ready" }),
      onPhase: (busy) => send({ kind: "phase", busy }),
      request: (request: PluginCapabilityRequest) => new Promise<PluginRunResult>((resolve) => {
        if (stopped || controller.signal.aborted) { resolve({ ok: false, code: "cancelled" }); return; }
        pending.set(request.id, resolve);
        try { send({ kind: "request", ...request }); }
        catch { pending.delete(request.id); resolve({ ok: false, code: "host-error" }); }
      }),
    });
  } catch { result = { ok: false, code: "runner-unavailable" }; }
  send({ kind: "result", result });
  stopped = true;
  stop();
  parentPort?.close();
}
void main();
