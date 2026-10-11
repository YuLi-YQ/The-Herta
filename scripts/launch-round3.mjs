/** Launch a real Electron desktop. No fake service and no sensitive net-log. */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [exe, label = "desktop-source", ...options] = process.argv.slice(2);
if (!exe || !/^[a-z0-9-]+$/.test(label))
  throw new Error("Expected executable and evidence label");
const evidence = resolve("docs/reports/evidence/round-3");
mkdirSync(evidence, { recursive: true });
const env = { ...process.env };
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "HERTA_UPDATE_URL",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
])
  delete env[key];
// Same per-install state path as the packaged app. Project tools use separate chosen fixtures.
env.HERTA_WORKSPACE_ROOT = join(process.env.APPDATA, "HertaAtelier");
const dev = options.indexOf("--dev");
const args = dev < 0 ? [] : [resolve(options[dev + 1])];
args.push("--remote-debugging-port=9338");
const child = spawn(resolve(exe), args, {
  cwd: resolve("."),
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
for (let n = 0; n < 80; n++) {
  if (exited) throw new Error("Desktop exited during startup");
  try {
    const pages = await (await fetch("http://127.0.0.1:9338/json/list")).json();
    if (pages.some((p) => p.type === "page" && p.url.startsWith("file:"))) {
      const status = {
        realElectron: true,
        pid: child.pid,
        executable: resolve(exe),
        dev: dev >= 0,
        rendererReady: true,
      };
      writeFileSync(
        resolve(evidence, `${label}-launch.json`),
        JSON.stringify(status, null, 2),
      );
      console.log(JSON.stringify(status));
      break;
    }
  } catch {
    /* startup */
  }
  await new Promise((r) => setTimeout(r, 250));
  if (n === 79) {
    child.kill();
    throw new Error("Desktop renderer unavailable");
  }
}
await new Promise((r) => {
  const timer = setInterval(() => {}, 1000);
  child.once("exit", () => {
    clearInterval(timer);
    r();
  });
});
