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
const evidence = resolve("docs/reports/evidence/round-2");
const cwd = resolve(".verification/黑塔 实验室（启动测试）");
mkdirSync(evidence, { recursive: true });
mkdirSync(cwd, { recursive: true });
const port = 9338;
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
const records = [];
async function capture(name) {
  const snapshot = await evaluate(
    `({title:document.title,url:location.href,text:document.body.innerText,bridge:typeof window.herta,require:typeof window.require,nodeProcess:typeof window.process,width:innerWidth,height:innerHeight,scale:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,images:Array.from(document.images).map(i=>({loaded:i.complete&&i.naturalWidth>0}))})`,
  );
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    resolve(evidence, `${label}-${name}.png`),
    Buffer.from(shot.data, "base64"),
  );
  records.push({ name, ...snapshot });
  return snapshot;
}
const initial = await capture("welcome");
if (
  initial.title !== "The Herta" ||
  initial.require !== "undefined" ||
  initial.nodeProcess !== "undefined"
)
  throw new Error("Desktop brand/isolation failed");
const baseURL = new URL(initial.url);
baseURL.search = "";
for (const scene of ["chat", "approval", "diff"]) {
  const page = new URL(baseURL);
  page.searchParams.set("demo", scene);
  await call("Page.navigate", { url: page.href });
  await sleep(800);
  const snapshot = await capture(scene);
  if (
    !snapshot.text.includes("不调用模型") ||
    !snapshot.text.includes("不执行工具")
  )
    throw new Error("Unlabelled demo");
}
await call("Page.navigate", { url: baseURL.href });
await sleep(600);
await evaluate(
  `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('设置 ·'))?.click()`,
);
await sleep(700);
await capture("settings");
const provider = await evaluate(
  `(async()=>{const v=await window.herta.getProviderSettings();return {count:v.settings.providers.length,runtimeActive:v.runtimeActive,statuses:v.credentialStatuses};})()`,
);
if (provider.runtimeActive !== false)
  throw new Error("Unexpected active runtime");
// Exercise actual main-process validation through the form, not a fake service.
await evaluate(
  `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('新增 Provider'))?.click()`,
);
await sleep(200);
await capture("settings-editor");
await evaluate(
  `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存连接')?.click()`,
);
await sleep(200);
await capture("settings-failure");
// Emulated renderer viewport is a layout check, not Windows DPI verification.
await call("Emulation.setDeviceMetricsOverride", {
  width: 960,
  height: 640,
  deviceScaleFactor: 1.5,
  mobile: false,
});
await sleep(400);
await capture("compact-viewport");
await call("Emulation.clearDeviceMetricsOverride");
const normal = await evaluate("window.herta.windowIsMaximized()");
await evaluate("window.herta.windowToggleMaximize()");
await sleep(400);
const maximized = await evaluate("window.herta.windowIsMaximized()");
await evaluate("window.herta.windowToggleMaximize()");
await sleep(400);
const restored = await evaluate("window.herta.windowIsMaximized()");
const result = {
  label,
  pid: child.pid,
  executable: resolve(executable),
  records,
  provider,
  windowChecks: { normal, maximized, restored },
  exceptions,
  passed:
    exceptions.length === 0 &&
    !normal &&
    maximized &&
    !restored &&
    records.every((r) => !r.overflow),
};
writeFileSync(
  resolve(evidence, `${label}.json`),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify({ label, pid: child.pid, passed: result.passed }));
if (!options.includes("--keep-open")) {
  await evaluate("window.herta.windowClose()");
  for (let i = 0; i < 40 && !exited; i++) await sleep(100);
  result.closedThroughUI = exited;
  writeFileSync(
    resolve(evidence, `${label}.json`),
    JSON.stringify(result, null, 2),
  );
  if (!exited) child.kill();
} else child.unref();
ws.close();
process.exitCode = result.passed ? 0 : 1;

if (options.includes("--keep-open"))
  await new Promise(() => setInterval(() => {}, 1000));
