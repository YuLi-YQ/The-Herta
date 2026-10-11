/** Actual packaged desktop launch with explicit isolated profile. No dev server. */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

const [exe, profile, label, port = "9345", visibility] = process.argv.slice(2);
if (
  !["9345", "9346"].includes(port) ||
  (visibility !== undefined && visibility !== "--hidden") ||
  process.argv.length > 7
)
  throw new Error(
    "Verification allows port 9345 or 9346 and optional --hidden only",
  );
const hidden = visibility === "--hidden";
if (
  !exe ||
  !profile ||
  !isAbsolute(exe) ||
  !isAbsolute(profile) ||
  !/^[a-z0-9-]+$/.test(label ?? "")
)
  throw new Error(
    "Expected absolute packaged exe, isolated profile, and evidence label",
  );
function canonical(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error("Verification profile ancestor unavailable");
    ancestor = parent;
  }
  if (!statSync(ancestor).isDirectory())
    throw new Error("Verification profile is not a directory");
  return join(realpathSync.native(ancestor), ...suffix);
}
function contains(parent, child) {
  const remainder = relative(parent, child);
  return (
    remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
  );
}
if (/^\\\\|^\/\//.test(profile)) throw new Error("Expected local test profile");
const personal = canonical(join(process.env.APPDATA ?? "", "HertaAtelier"));
const isolated = canonical(profile);
if (contains(personal, isolated) || contains(isolated, personal))
  throw new Error("Personal profile is forbidden");
const evidence = resolve("docs/reports/evidence/round-12");
mkdirSync(evidence, { recursive: true });
mkdirSync(profile, { recursive: true });
const cwd = join(profile, "verification-launch-cwd");
mkdirSync(cwd, { recursive: true });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    /API.?KEY|ACCESS.?TOKEN|AUTH.?TOKEN|SECRET|HERTA_.*(?:UPDATE|WORKSPACE)|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL/i.test(
      key,
    )
  )
    delete env[key];
try {
  await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(500),
  });
  throw new Error(
    `Debug port ${port} already active; close previous verification desktop`,
  );
} catch (error) {
  if (error.message.startsWith("Debug port")) throw error;
}
const start = performance.now();
const child = spawn(
  exe,
  [
    "--herta-verification",
    `--herta-test-profile=${profile}`,
    `--remote-debugging-port=${port}`,
  ],
  {
    cwd,
    env,
    windowsHide: hidden,
    stdio: [
      "ignore",
      openSync(join(evidence, `${label}-stdout.log`), "w"),
      openSync(join(evidence, `${label}-stderr.log`), "w"),
    ],
  },
);
let ended = false;
let spawnError;
const exited = new Promise((done) => {
  child.once("error", (error) => {
    spawnError = error;
    ended = true;
    done();
  });
  child.once("exit", (code) => {
    ended = true;
    done(code);
  });
});
let status;
for (let n = 0; n < 600; n++) {
  if (ended)
    throw new Error(
      spawnError
        ? "Packaged desktop failed to spawn"
        : "Packaged desktop exited before readiness",
    );
  try {
    const pages = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      })
    ).json();
    const page = pages.find(
      (p) => p.type === "page" && p.url.startsWith("file:"),
    );
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((done, reject) => {
        ws.addEventListener("open", done, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      const ready = new Promise((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Readiness probe unavailable")),
          1500,
        );
        ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) {
            clearTimeout(timer);
            done(message.result);
          }
        });
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            returnByValue: true,
            expression:
              "(async()=>{if(typeof window.herta?.getAppVersion!=='function'||document.readyState==='loading')return null;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {version:await window.herta.getAppVersion(),bridge:true,title:document.title,require:typeof window.require,nodeProcess:typeof window.process};})()",
          },
        }),
      );
      let value;
      try {
        value = (await ready)?.result?.value;
      } finally {
        ws.close();
      }
      if (value) {
        status = {
          realPackagedElectron: true,
          verificationPort: Number(port),
          launchVisibility: hidden ? "hidden-background-stage" : "visible",
          measurement:
            "spawn to file renderer + bridge version + double requestAnimationFrame",
          readyMs: Math.round(performance.now() - start),
          pid: child.pid,
          executable: exe,
          isolatedProfile: profile,
          cwd,
          targetURL: page.url,
          ...value,
        };
        writeFileSync(
          join(evidence, `${label}-launch.json`),
          JSON.stringify(status, null, 2),
        );
        console.log(JSON.stringify(status));
        break;
      }
    }
  } catch {
    /* Startup polling never prints raw errors. */
  }
  await new Promise((done) => setTimeout(done, 100));
}
if (!status) {
  child.kill();
  throw new Error("Packaged desktop readiness timed out");
}
const exitCode = await exited;
writeFileSync(
  join(evidence, `${label}-exit.json`),
  JSON.stringify({ exited: true, exitCode, pid: child.pid }, null, 2),
);
