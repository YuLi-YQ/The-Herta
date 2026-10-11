/** Real packaged desktop failure paths against deterministic loopback HTTP only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve("docs/reports/evidence/round-4");
mkdirSync(evidence, { recursive: true });
const service = await fetch("http://127.0.0.1:9344/__stats").then((r) =>
  r.json(),
);
assert.equal(service.deterministicFixture, true);
const pages = await fetch("http://127.0.0.1:9346/json/list").then((r) =>
  r.json(),
);
const page = pages.find((p) => p.type === "page" && p.url.startsWith("file:"));
assert(page);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  ws.addEventListener("open", done, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let serial = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const task = pending.get(message.id);
  if (task) {
    clearTimeout(task.timer);
    pending.delete(message.id);
    message.error
      ? task.reject(new Error("Fixture desktop CDP rejected"))
      : task.done(message.result);
  }
});
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Fixture desktop exceeded 20 seconds"));
    }, 20000);
    pending.set(id, { done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error("Fixture desktop evaluation rejected");
  return result.result.value;
}
const invoke = (method, input) =>
  evaluate(
    `window.herta.${method}(${input === undefined ? "" : JSON.stringify(input)})`,
  );
const records = [];
const output = {
  scope:
    "Actual installed Electron on 9346 using deterministic local HTTP service; not external API success/failure",
  records,
};
try {
  for (const protocol of [
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ]) {
    const provider = await evaluate(
      `(async()=>{const name=${JSON.stringify(`R4 A07 deterministic ${protocol}`)};const prior=(await window.herta.getProviderSettings()).settings.providers.find(p=>p.name===name);const v=await window.herta.saveProvider({...(prior?{id:prior.id,expectedRevision:prior.revision}:{}),name,protocol:${JSON.stringify(protocol)},baseURL:'http://127.0.0.1:9344/normal/prefix/v1',authentication:'none',allowRemoteHTTP:false,models:[{id:'r4-fixture'}],defaults:{model:'r4-fixture',timeoutMs:1000},credential:{action:'clear'}});const p=v.settings.providers.find(p=>p.name===name);return {id:p.id,revision:p.revision};})()`,
    );
    const probe = await evaluate(
      `(async()=>{const r=await window.herta.validateProviderModel({providerId:${JSON.stringify(provider.id)},expectedRevision:${provider.revision},modelId:'r4-fixture',kind:'tools'});return r.validation;})()`,
    );
    assert.equal(probe.state, "tools-available");
    await evaluate(
      `(async()=>{await window.herta.setProviderBindings({bindings:{persona:{providerId:${JSON.stringify(provider.id)},modelId:'r4-fixture'},executor:{providerId:${JSON.stringify(provider.id)},modelId:'r4-fixture'}}});return true;})()`,
    );
    for (const mode of ["HOLD", "UNAVAILABLE", "DROP"]) {
      const root = resolve(
        ".verification/round-4",
        `故障验证 ${Date.now()}（${protocol}-${mode}）`,
      );
      mkdirSync(root, { recursive: true });
      execFileSync("git", ["init", "--quiet", "--", root], {
        windowsHide: true,
      });
      const session = await evaluate(
        `(async()=>{const s=await window.herta.createSession(${JSON.stringify({ workspaceRoot: root, backendWorkspace: root, lang: "zh" })});return {sessionId:s.sessionId};})()`,
      );
      await evaluate(
        "(()=>{window.__r4Fault=[];window.__r4FaultOff?.forEach(f=>f());window.__r4FaultOff=[window.herta.onTurn(e=>window.__r4Fault.push({channel:'turn',event:e})),window.herta.onRecord(e=>window.__r4Fault.push({channel:'record',event:e})),window.herta.onOverlay(e=>window.__r4Fault.push({channel:'overlay',event:e}))];return true;})()",
      );
      const started = performance.now();
      let submitRejected = false;
      await invoke(
        "submitText",
        `这是确定性本地故障验证，只回复文本，禁止调用工具。R4:${mode} R4:ID=${protocol.replace(/-/g, "_")}_${mode}`,
      ).catch(() => {
        submitRejected = true;
      });
      const actual = await evaluate(
        "({events:window.__r4Fault,text:document.body.innerText.slice(-5000),composerEnabled:!document.querySelector('#herta-draft').disabled})",
      );
      const failure = actual.events.find(
        (e) => e.channel === "turn" && e.event.kind === "failed",
      );
      assert(failure, "Actual packaged session must report failed");
      assert(
        !actual.events.some(
          (e) => e.channel === "turn" && e.event.kind === "finished",
        ),
      );
      assert(
        !actual.events.some(
          (e) => e.channel === "overlay" && e.event.kind === "pending",
        ),
        "Fault requests must never execute tools",
      );
      if (mode === "HOLD")
        assert.equal(failure.event.error.providerCode, "stall");
      if (mode === "UNAVAILABLE") assert.equal(failure.event.error.status, 503);
      if (mode === "DROP") {
        assert.equal(failure.event.error.providerCode, "sse");
        assert(
          JSON.stringify(actual.events).includes("确定性测试"),
          "Partial received output must remain",
        );
      }
      records.push({
        protocol,
        mode,
        sessionId: session.sessionId,
        timeoutMs: 1000,
        submitRejected,
        actualElapsedMs: performance.now() - started,
        ...actual,
        functionalAssertionsPassed: true,
      });
      writeFileSync(
        resolve(evidence, "core-fault-desktop-results.json"),
        JSON.stringify(output, null, 2),
      );
      console.log(
        JSON.stringify({
          protocol,
          mode,
          sessionId: session.sessionId,
          failure: failure.event.error,
          elapsedMs: Math.round(records.at(-1).actualElapsedMs),
        }),
      );
      await evaluate(
        "(()=>{window.__r4FaultOff.forEach(f=>f());window.__r4FaultOff=[];return true;})()",
      );
    }
  }
} catch (error) {
  output.failed = error.message;
  process.exitCode = 1;
} finally {
  await invoke("interrupt").catch(() => {});
  await evaluate(
    "(()=>{window.__r4FaultOff?.forEach(f=>f());window.__r4FaultOff=[];return true;})()",
  ).catch(() => {});
  writeFileSync(
    resolve(evidence, "core-fault-desktop-results.json"),
    JSON.stringify(output, null, 2),
  );
  ws.close();
}
console.log(
  JSON.stringify({
    completedCases: records.length,
    failed: output.failed ?? null,
    scope: output.scope,
    windowLeftOpen: true,
  }),
);
