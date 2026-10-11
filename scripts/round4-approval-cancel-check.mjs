/** Actual packaged delegate -> executor -> pending write -> UI cancel -> stale approval.
 * Deterministic loopback protocol service, not an external API pass. No allowed writes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve("docs/reports/evidence/round-4");
mkdirSync(evidence, { recursive: true });
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
      ? task.reject(new Error("Approval cancellation CDP rejected"))
      : task.done(message.result);
  }
});
const call = (method, params = {}) =>
  new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Approval cancellation exceeded 20 seconds"));
    }, 20000);
    pending.set(id, { done, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error("Approval cancellation desktop IPC rejected");
  return result.result.value;
}
const invoke = (method, ...input) =>
  evaluate(
    `window.herta.${method}(${input.map((value) => JSON.stringify(value)).join(",")})`,
  );
const stats = () =>
  fetch("http://127.0.0.1:9344/__stats").then((r) => r.json());
const wait = async (predicate, label) => {
  const start = Date.now();
  while (Date.now() - start < 7000) {
    const value = await predicate();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
};
const output = {
  scope:
    "Actual installed Electron on 9346 via CDP renderer cancel button and real IPC; deterministic loopback HTTP only; not external API",
  cases: [],
};
let inFlight;
try {
  for (const protocol of [
    "openai-responses",
    "openai-chat-completions",
    "anthropic-messages",
  ]) {
    const provider = await evaluate(
      `(async()=>{const name=${JSON.stringify(`R4 A04 deterministic ${protocol}`)};const v=await window.herta.saveProvider({name,protocol:${JSON.stringify(protocol)},baseURL:'http://127.0.0.1:9344/normal/prefix/v1',authentication:'none',allowRemoteHTTP:false,models:[{id:'r4-fixture'}],defaults:{model:'r4-fixture',timeoutMs:30000},credential:{action:'clear'}});const p=v.settings.providers.find(p=>p.name===name);const r=await window.herta.validateProviderModel({providerId:p.id,expectedRevision:p.revision,modelId:'r4-fixture',kind:'tools'});if(r.validation.state!=='tools-available')throw new Error('Probe failed');await window.herta.setProviderBindings({bindings:{persona:{providerId:p.id,modelId:'r4-fixture'},executor:{providerId:p.id,modelId:'r4-fixture'}}});return {id:p.id};})()`,
    );
    const root = resolve(
      ".verification/round-4",
      `审批取消 ${Date.now()}（${protocol}）`,
    );
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--", root], { windowsHide: true });
    const session = await evaluate(
      `(async()=>{const s=await window.herta.createSession(${JSON.stringify({ workspaceRoot: root, backendWorkspace: root, lang: "zh" })});return {sessionId:s.sessionId};})()`,
    );
    await evaluate(
      "(()=>{window.__r4Cancel={events:[],overlay:null};window.__r4CancelOff=[window.herta.onOverlay(e=>{window.__r4Cancel.events.push({channel:'overlay',event:e});if(e.kind==='pending')window.__r4Cancel.overlay=e.overlay;else if(e.kind==='resolved')window.__r4Cancel.overlay=null;}),window.herta.onTurn(e=>window.__r4Cancel.events.push({channel:'turn',event:e})),window.herta.onRecord(e=>window.__r4Cancel.events.push({channel:'record',event:e}))];return true;})()",
    );
    const marker = `A04_${protocol.replace(/-/g, "_")}`;
    inFlight = invoke(
      "submitText",
      `仅在当前隔离项目委派执行器尝试创建取消测试.txt，等待审批。R4:WRITE R4:ID=${marker}`,
    ).then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    const overlay = await wait(
      () => evaluate("window.__r4Cancel.overlay"),
      "actual pending tool approval",
    );
    assert.equal(overlay.kind, "pending-permission");
    assert.equal(overlay.tool, "write_new_file");
    assert.deepEqual(overlay.files, ["取消测试.txt"]);
    assert(
      overlay.diff.includes(
        "R4 deterministic approval cancellation must not write this file.",
      ),
    );
    assert.equal(existsSync(resolve(root, "取消测试.txt")), false);
    const requests = (await stats()).records.filter((r) => r.label === marker);
    assert(requests.some((r) => r.tool === "delegate_execution"));
    assert(requests.some((r) => r.tool === "write_new_file"));
    await evaluate(
      "(()=>{const b=[...document.querySelectorAll('.herta-approval button')].find(b=>b.textContent.trim()==='取消本轮');if(!b||b.disabled)throw new Error('Cancel unavailable');b.click();return true;})()",
    );
    const submitted = await inFlight;
    inFlight = undefined;
    const actual = await evaluate("window.__r4Cancel");
    assert(
      actual.events.some(
        (e) =>
          e.channel === "turn" &&
          e.event.kind === "failed" &&
          e.event.error.code === "AbortError",
      ),
    );
    assert(
      !actual.events.some(
        (e) => e.channel === "turn" && e.event.kind === "finished",
      ),
    );
    assert.equal(actual.overlay, null);
    const stale = await invoke("resolveApproval", {
      requestId: overlay.requestId,
      decision: "allow",
      persistence: "once",
    });
    assert.equal(
      stale.ok,
      false,
      "Cancelled approval must not authorize any write",
    );
    assert(["stale_request", "no_pending_overlay"].includes(stale.reason));
    assert.equal(existsSync(resolve(root, "取消测试.txt")), false);
    const path = resolve(
      ".verification/round-4/profile-performance/.herta/transcript/v2",
      `${session.sessionId}.jsonl`,
    );
    const persisted = readFileSync(path, "utf8");
    assert(persisted.includes("interrupted"));
    const sha256 = createHash("sha256").update(persisted).digest("hex");
    const count = (await stats()).records.length;
    await invoke("openSession", session.sessionId);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await stats()).records.length, count);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      sha256,
    );
    assert.equal(existsSync(resolve(root, "取消测试.txt")), false);
    output.cases.push({
      protocol,
      sessionId: session.sessionId,
      providerId: provider.id,
      root,
      overlay,
      submitted,
      staleApproval: stale,
      events: actual.events,
      requests,
      persisted: {
        path,
        bytes: Buffer.byteLength(persisted),
        sha256,
        interrupted: true,
        unchangedOnOpen: true,
      },
      cancelledFileAbsent: true,
      functionalAssertionsPassed: true,
    });
    await evaluate(
      "(()=>{window.__r4CancelOff.forEach(f=>f());window.__r4CancelOff=[];return true;})()",
    );
    writeFileSync(
      resolve(evidence, "core-approval-cancel-results.json"),
      JSON.stringify(output, null, 2),
    );
    console.log(
      JSON.stringify({
        protocol,
        sessionId: session.sessionId,
        cancelled: true,
        staleApproval: stale,
        fileAbsent: true,
        historyNoReplay: true,
      }),
    );
  }
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    resolve(evidence, "core-approval-cancel-history.png"),
    Buffer.from(shot.data, "base64"),
  );
} catch (error) {
  output.failure = error.message;
  process.exitCode = 1;
} finally {
  if (inFlight) {
    await invoke("interrupt").catch(() => {});
    await inFlight;
  }
  await evaluate(
    "(()=>{window.__r4CancelOff?.forEach(f=>f());window.__r4CancelOff=[];return true;})()",
  ).catch(() => {});
  writeFileSync(
    resolve(evidence, "core-approval-cancel-results.json"),
    JSON.stringify(output, null, 2),
  );
  ws.close();
}
console.log(
  JSON.stringify({
    completedCases: output.cases.length,
    failure: output.failure ?? null,
    windowLeftOpen: true,
    scope: output.scope,
  }),
);
