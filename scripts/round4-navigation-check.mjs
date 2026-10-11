/** Actual packaged UI via CDP DOM button clicks; fixture SSE, not external API. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const evidence = resolve("docs/reports/evidence/round-4");
const profile = resolve(".verification/round-4/profile-performance");
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
      ? task.reject(new Error("Navigation CDP rejected"))
      : task.done(message.result);
  }
});
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Navigation CDP timed out"));
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
  if (result.exceptionDetails) throw new Error("Navigation UI/IPC rejected");
  return result.result.value;
}
const invoke = (method, ...input) =>
  evaluate(
    `window.herta.${method}(${input.map((value) => JSON.stringify(value)).join(",")})`,
  );
const stats = () =>
  fetch("http://127.0.0.1:9344/__stats").then((r) => r.json());
const wait = async (predicate, description) => {
  const start = Date.now();
  while (Date.now() - start < 7000) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${description}`);
};
const click = (text) =>
  evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Button unavailable');b.click();return true;})()`,
  );
const active = (root) =>
  evaluate(
    `document.querySelector('.herta-history button[aria-current="page"]')?.title===${JSON.stringify(root)}`,
  );
async function historyClick(root) {
  await wait(
    () =>
      evaluate(
        `Boolean([...document.querySelectorAll('.herta-history button')].find(b=>b.title===${JSON.stringify(root)}&&!b.disabled))`,
      ),
    "history button available",
  );
  return evaluate(
    `(()=>{const b=[...document.querySelectorAll('.herta-history button')].find(b=>b.title===${JSON.stringify(root)});b.click();return true;})()`,
  );
}
async function type(text) {
  await evaluate("document.querySelector('#herta-draft').focus();true");
  await call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await call("Input.insertText", { text });
  await evaluate(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
  );
}
const result = {
  scope:
    "Actual installed renderer buttons via CDP DOM clicks and Chromium input; deterministic long SSE on loopback; not OS mouse/IME or external API",
  checks: {},
};
let running = false;
try {
  const provider = await evaluate(
    "(async()=>{const v=await window.herta.saveProvider({name:'R4 A08 deterministic long stream',protocol:'openai-responses',baseURL:'http://127.0.0.1:9344/normal/prefix/v1',authentication:'none',allowRemoteHTTP:false,models:[{id:'r4-fixture'}],defaults:{model:'r4-fixture',timeoutMs:30000},credential:{action:'clear'}});const p=v.settings.providers.find(p=>p.name==='R4 A08 deterministic long stream');const probe=await window.herta.validateProviderModel({providerId:p.id,expectedRevision:p.revision,modelId:'r4-fixture',kind:'tools'});if(probe.validation.state!=='tools-available')throw new Error('Probe failed');await window.herta.setProviderBindings({bindings:{persona:{providerId:p.id,modelId:'r4-fixture'},executor:{providerId:p.id,modelId:'r4-fixture'}}});return {id:p.id};})()",
  );
  result.fixtureProvider = provider.id;
  const root = resolve(".verification/round-4", `双会话导航 ${Date.now()}`);
  const rootA = resolve(root, "黑塔 会话（A）"),
    rootB = resolve(root, "黑塔 会话（B）");
  for (const dir of [rootA, rootB]) {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--", dir], { windowsHide: true });
  }
  const a = await invoke("createSession", {
    workspaceRoot: rootA,
    backendWorkspace: rootA,
    lang: "zh",
  });
  const titleA = `A08-A-${Date.now()}`;
  await invoke("renameSession", a.sessionId, titleA);
  const b = await invoke("createSession", {
    workspaceRoot: rootB,
    backendWorkspace: rootB,
    lang: "zh",
  });
  const titleB = `A08-B-${Date.now()}`;
  await invoke("renameSession", b.sessionId, titleB);
  result.sessions = {
    a: { id: a.sessionId, root: rootA },
    b: { id: b.sessionId, root: rootB },
  };
  const draftA = "A08 草稿 A：只属于旧会话",
    draftB = "A08 草稿 B：只属于另一个会话";
  await type(draftB);
  await historyClick(rootA);
  await wait(() => active(rootA), "open A through history button");
  await evaluate(
    "(()=>{window.__r4NavEvents=[];window.__r4NavOff=[window.herta.onReset(e=>window.__r4NavEvents.push({channel:'reset',sessionId:e.sessionId})),window.herta.onTurn(e=>window.__r4NavEvents.push({channel:'turn',event:e})),window.herta.onRecord(e=>window.__r4NavEvents.push({channel:'record',kind:e.kind,blockKind:e.block?.kind,textMarker:e.block?.text?.includes('A08_A')??e.block?.body?.includes('A08_A')??false}))];return true;})()",
  );
  await type("只回复文本，禁止调用工具。R4:LONG R4:ID=A08_A");
  await click("发送");
  running = true;
  await wait(
    () =>
      evaluate(
        "document.querySelector('.herta-transcript')?.innerText.includes('确定性测试 A08_A')",
      ),
    "actual partial SSE output",
  );
  await type(draftA);
  await historyClick(rootB);
  await wait(
    () =>
      evaluate(
        "Boolean(document.querySelector('[aria-label=\"切换任务确认\"]'))",
      ),
    "switch confirmation",
  );
  await click("留在当前任务");
  assert(await active(rootA));
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('[aria-label=\"切换任务确认\"]'))",
    ),
    false,
  );
  const stillStreaming = (await stats()).records.findLast(
    (r) => r.label === "A08_A",
  );
  assert(stillStreaming && !stillStreaming.closed);
  result.checks.cancelConfirmationKeepsAAndStream = true;
  await historyClick(rootB);
  await wait(
    () =>
      evaluate(
        "Boolean(document.querySelector('[aria-label=\"切换任务确认\"]'))",
      ),
    "second switch confirmation",
  );
  await click("停止并切换");
  await wait(() => active(rootB), "confirmed switch to B");
  running = false;
  await wait(
    async () =>
      (await stats()).records.findLast((r) => r.label === "A08_A")?.closed,
    "actual old request socket closed",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('#herta-draft').value===${JSON.stringify(draftB)}`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.herta-transcript')?.innerText.includes('A08_A')",
    ),
    false,
  );
  await new Promise((done) => setTimeout(done, 1200));
  assert(await active(rootB));
  assert.equal(
    await evaluate(
      "document.querySelector('.herta-transcript')?.innerText.includes('A08_A')",
    ),
    false,
  );
  result.checks.confirmedStopSwitchesAndClosesOldSocket = true;
  result.checks.bDraftAndDelayedEventIsolation = true;
  const transcriptPath = resolve(
    profile,
    ".herta/transcript/v2",
    `${a.sessionId}.jsonl`,
  );
  const persisted = readFileSync(transcriptPath, "utf8");
  assert(persisted.includes("A08_A") && persisted.includes("确定性测试"));
  assert(persisted.includes("interrupted"));
  const digest = createHash("sha256").update(persisted).digest("hex");
  const before = (await stats()).records.length;
  await historyClick(rootA);
  await wait(() => active(rootA), "reopen A history");
  assert.equal(
    await evaluate(
      `document.querySelector('#herta-draft').value===${JSON.stringify(draftA)}`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.herta-transcript')?.innerText.includes('确定性测试 A08_A')",
    ),
    true,
  );
  await new Promise((done) => setTimeout(done, 700));
  assert.equal((await stats()).records.length, before);
  assert.equal(
    createHash("sha256").update(readFileSync(transcriptPath)).digest("hex"),
    digest,
  );
  result.checks.historyAndDraftReopenWithoutReplay = true;
  result.persisted = {
    path: transcriptPath,
    bytes: Buffer.byteLength(persisted),
    sha256: digest,
    containsPartial: true,
    interrupted: true,
    unchangedOnOpen: true,
  };
  result.events = await evaluate("window.__r4NavEvents");
  result.actualHTTP = (await stats()).records.filter(
    (r) => r.label === "A08_A",
  );
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    resolve(evidence, "core-navigation-history.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  result.functionalAssertionsPassed = true;
} catch (error) {
  result.failure = error.message;
  process.exitCode = 1;
} finally {
  if (running) await invoke("interrupt").catch(() => {});
  await evaluate(
    "(()=>{window.__r4NavOff?.forEach(f=>f());window.__r4NavOff=[];return true;})()",
  ).catch(() => {});
  writeFileSync(
    resolve(evidence, "core-navigation-results.json"),
    JSON.stringify(result, null, 2),
  );
  ws.close();
}
console.log(JSON.stringify(result));
