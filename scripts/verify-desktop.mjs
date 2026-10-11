/** Actual Electron process probe. No renderer mocks or fake service responses.
 * node scripts/verify-desktop.mjs <exe> <label> [--dev <appDir>] [--keep-open]
 * Read-only DOM/CDP checks plus disabled-feature IPC checks; saves real frames.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [executable, label, ...options] = process.argv.slice(2);
if (!executable || !label || !/^[a-z0-9-]+$/.test(label)) {
  throw new Error(
    "usage: verify-desktop.mjs <exe> <label> [--dev <appDir>] [--keep-open]",
  );
}
const evidence = resolve("docs/reports/evidence/round-1");
const cwd = resolve(".verification/黑塔 实验室（启动测试）");
mkdirSync(evidence, { recursive: true });
mkdirSync(cwd, { recursive: true });
const port = 9337;
const env = { ...process.env };
for (const name of [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "HERTA_UPDATE_URL",
])
  delete env[name];
const devAt = options.indexOf("--dev");
const args = devAt < 0 ? [] : [resolve(options[devAt + 1])];
args.push(
  `--remote-debugging-port=${port}`,
  `--log-net-log=${resolve(evidence, `${label}-netlog.json`)}`,
);
const startedAt = Date.now();
const child = spawn(resolve(executable), args, {
  cwd,
  env,
  windowsHide: true,
  stdio: [
    "ignore",
    openSync(resolve(evidence, `${label}-stdout.log`), "w"),
    openSync(resolve(evidence, `${label}-stderr.log`), "w"),
  ],
});
let exited = false;
child.once("exit", () => {
  exited = true;
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let target;
for (let i = 0; i < 60; i++) {
  if (exited)
    throw new Error("Electron exited before a renderer was available");
  try {
    const pages = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    target = pages.find(
      (page) => page.type === "page" && page.url.startsWith("file:"),
    );
    if (target) break;
  } catch {
    /* real startup still loading */
  }
  await sleep(250);
}
if (!target) {
  child.kill();
  throw new Error("No real file-backed Electron renderer after 15s");
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  ws.addEventListener("open", done, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let serial = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Runtime.exceptionThrown")
    exceptions.push(message.params.exceptionDetails);
  if (message.id) {
    const item = pending.get(message.id);
    if (item) {
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error
        ? item.reject(new Error(JSON.stringify(message.error)))
        : item.resolve(message.result);
    }
  }
});
function call(method, params = {}) {
  const id = ++serial;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve: resolveCall, reject, timer });
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
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
await call("Runtime.enable");
await sleep(2000);
const snapshot = await evaluate(
  `({title:document.title,url:location.href,text:document.body.innerText,bridge:typeof window.herta,require:typeof window.require,nodeProcess:typeof window.process,userAgent:navigator.userAgent,width:innerWidth,height:innerHeight,scale:devicePixelRatio,images:Array.from(document.images).map(i=>({src:i.currentSrc,loaded:i.complete&&i.naturalWidth>0})),scripts:Array.from(document.scripts).map(s=>s.src).filter(Boolean)})`,
);
const controls = await evaluate(
  `(async()=>{const b=window.herta;const r={};for(const [name,args] of [['getAutoUpdate',[]],['getRealtimeVoice',[]],['getUpdateState',[]],['setRealtimeVoice',[true]],['downloadVoiceModel',[]],['checkForUpdate',[]],['setAutoUpdate',[true]]]){if(typeof b?.[name]!=='function'){r[name]={absent:true};continue;}try{r[name]={resolved:true,value:await b[name](...args)};}catch(e){r[name]={rejected:true,message:String(e.message||e)};}}return r;})()`,
);
const screenshot = await call("Page.captureScreenshot", { format: "png" });
writeFileSync(
  resolve(evidence, `${label}.png`),
  Buffer.from(screenshot.data, "base64"),
);
const passed =
  snapshot.url.startsWith("file:") &&
  snapshot.bridge === "object" &&
  snapshot.require === "undefined" &&
  snapshot.nodeProcess === "undefined" &&
  snapshot.text.includes("第 1 轮") &&
  snapshot.images.every((image) => image.loaded) &&
  exceptions.length === 0 &&
  controls.getAutoUpdate?.value === false &&
  controls.setRealtimeVoice?.rejected === true &&
  controls.downloadVoiceModel?.rejected === true &&
  controls.checkForUpdate?.rejected === true &&
  controls.setAutoUpdate?.rejected === true;
const result = {
  label,
  executable: resolve(executable),
  pid: child.pid,
  cwd,
  startedAt: new Date(startedAt).toISOString(),
  capturedAfterMs: Date.now() - startedAt,
  snapshot,
  controls,
  exceptions,
  passed,
};
writeFileSync(
  resolve(evidence, `${label}.json`),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    label,
    pid: child.pid,
    passed,
    screenshot: resolve(evidence, `${label}.png`),
    controls,
  }),
);
if (!options.includes("--keep-open")) {
  await evaluate("window.herta.windowClose()");
  for (let i = 0; i < 40 && !exited; i++) await sleep(100);
  result.closedThroughUI = exited;
  if (!exited) child.kill();
  writeFileSync(
    resolve(evidence, `${label}.json`),
    JSON.stringify(result, null, 2),
  );
} else child.unref();
ws.close();
process.exitCode = passed ? 0 : 1;
