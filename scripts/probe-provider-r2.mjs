/** Real Electron configuration IPC probe; no network service is invoked. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const mode = process.argv[2] || "create";
const dir = resolve("docs/reports/evidence/round-2");
mkdirSync(dir, { recursive: true });
const saved = resolve(".verification/round-2-provider-state.json");
const pages = await (await fetch("http://127.0.0.1:9338/json/list")).json();
const ws = new WebSocket(
  pages.find((p) => p.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let n = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String(e.data));
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error
      ? p.reject(new Error(JSON.stringify(m.error)))
      : p.resolve(m.result);
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const invoke = (name, arg) =>
  evaluate(
    `window.herta.${name}(${arg === undefined ? "" : JSON.stringify(arg)})`,
  );
const root = join(process.env.APPDATA, "HertaAtelier");
const historical = () =>
  Object.fromEntries(
    ["settings.json", "deepseek-key.enc", "deepseek-key.txt"]
      .filter((f) => existsSync(join(root, f)))
      .map((f) => [
        f,
        createHash("sha256")
          .update(readFileSync(join(root, f)))
          .digest("hex"),
      ]),
  );
const result = { mode, realElectronIPC: true, realService: false };
if (mode === "create") {
  const before = await invoke("getProviderSettings");
  const ids = [];
  const protocols = [
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ];
  for (const protocol of protocols) {
    const v = await invoke("saveProvider", {
      name: `R2 temporary verification ${protocol}`,
      protocol,
      baseURL: "https://example.invalid/gateway/v1",
      authentication: "api-key",
      allowRemoteHTTP: false,
      models: [{ id: "round2-manual-model" }],
      defaults: { model: "round2-manual-model", timeoutMs: 30000 },
      credential: {
        action: "replace",
        value: "synthetic-round2-local-storage-check",
      },
    });
    const p = v.settings.providers.find(
      (p) => p.name === `R2 temporary verification ${protocol}`,
    );
    if (
      !p ||
      !v.credentialStatuses[p.id]?.encrypted ||
      v.runtimeActive !== false
    )
      throw new Error("Credential/config failed");
    ids.push(p.id);
    const disk = readFileSync(
      join(root, "provider-credentials", p.credentialRef + ".enc"),
    );
    if (disk.includes(Buffer.from("synthetic-round2-local-storage-check")))
      throw new Error("Plaintext credential");
  }
  const bindings = {
    persona: { providerId: ids[0], modelId: "round2-manual-model" },
    executor: { providerId: ids[2], modelId: "round2-manual-model" },
  };
  await invoke("setProviderBindings", { bindings });
  await invoke("setProviderBindings", {
    sessionId: "round2-verification-only",
    bindings,
  });
  writeFileSync(
    saved,
    JSON.stringify(
      { ids, before, binding: bindings, historical: historical() },
      null,
      2,
    ),
  );
  result.created = ids.length;
  result.encryptedOnDisk = true;
  result.mixedGlobalAndSessionBindings = true;
} else {
  const state = JSON.parse(readFileSync(saved, "utf8"));
  const view = await invoke("getProviderSettings");
  if (mode === "restart") {
    result.restored = state.ids.every(
      (id) =>
        view.settings.providers.some((p) => p.id === id) &&
        view.credentialStatuses[id]?.set &&
        view.credentialStatuses[id]?.encrypted,
    );
    result.bindingsRestored =
      JSON.stringify(view.settings.defaultBindings) ===
        JSON.stringify(state.binding) &&
      JSON.stringify(
        view.settings.sessionBindings["round2-verification-only"],
      ) === JSON.stringify(state.binding);
    result.oldCredentialHashUnchanged = [
      "deepseek-key.enc",
      "deepseek-key.txt",
    ].every((f) => historical()[f] === state.historical[f]);
    if (
      !result.restored ||
      !result.bindingsRestored ||
      !result.oldCredentialHashUnchanged
    )
      throw new Error("Restart persistence failed");
  } else if (mode === "cleanup") {
    for (const id of state.ids) await invoke("deleteProvider", id);
    await invoke("setProviderBindings", {
      bindings: state.before.settings.defaultBindings,
    });
    result.originalProvidersPreserved =
      (await invoke("getProviderSettings")).settings.providers.length ===
      state.before.settings.providers.length;
  }
}
result.passed = true;
writeFileSync(
  join(dir, `provider-desktop-${mode}.json`),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
ws.close();
