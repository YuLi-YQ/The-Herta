/**
 * Stage the neural-voice native runtime for packaging (ADR 0042).
 *
 *   node scripts/stage-tts.mjs                 # this machine's platform
 *   node scripts/stage-tts.mjs --mac           # both macOS arches
 *   node scripts/stage-tts.mjs --win           # windows x64
 *   node scripts/stage-tts.mjs --linux         # linux x64 (the AppImage)
 *   node scripts/stage-tts.mjs --check         # report, stage nothing
 *
 * WHY A STAGING STEP. `sherpa-onnx-node` is the one NATIVE dependency the app
 * loads, and it cannot go through the normal path: electron-vite bundles
 * main's entire dependency graph into `out/main`, and a `.node` addon cannot
 * be bundled — the packaging invariant CI greps for ("no native refs in the
 * main bundle") depends on it never being imported there. So the worker
 * `require`s it by ABSOLUTE PATH at runtime, and this script puts a plain,
 * symlink-free copy where that path points: `<resources>/tts-runtime/`.
 *
 * A plain directory copy is also what makes it work at all in a packaged
 * app. pnpm's `node_modules` is a forest of symlinks into `.pnpm`;
 * electron-builder would either follow them into an unrelated tree or copy
 * the links themselves. And the addon finds its own platform package by
 * walking a SIBLING path (`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`
 * — see the upstream `addon.js`), so the two packages must sit next to each
 * other as real directories. That is exactly the layout produced here.
 *
 * Cross-arch builds (an arm64 mac runner packaging the x64 app) need a
 * platform package pnpm refused to install — its `os`/`cpu` fields exclude
 * the host. Those are fetched on demand with `npm install --force` into a
 * build-local cache. Nothing is fetched when the package is already present.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(GUI_ROOT, "../..");
const STAGE_DIR = join(GUI_ROOT, "tts-runtime");
const CACHE_DIR = join(GUI_ROOT, "node_modules", ".tts-fetch");

/** Pinned with the dependency in packages/gui/package.json. One exact
 *  version across every platform package — a mismatch between the JS wrapper
 *  and the addon is an unloadable module, not a graceful degrade. */
const VERSION = readPinnedVersion();

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");

/** Platform packages to stage, as npm names. */
function targets() {
  if (argv.includes("--mac")) {
    return ["sherpa-onnx-darwin-arm64", "sherpa-onnx-darwin-x64"];
  }
  if (argv.includes("--win")) return ["sherpa-onnx-win-x64"];
  // Explicit, like --win/--mac (platform review 2026-09-23): the Linux build
  // used to stage "this machine's platform", so running it on the wrong host
  // packed a Windows or macOS addon into the AppImage and every gate passed.
  if (argv.includes("--linux")) return ["sherpa-onnx-linux-x64"];
  const map = {
    win32: `sherpa-onnx-win-${process.arch}`,
    darwin: `sherpa-onnx-darwin-${process.arch}`,
    linux: `sherpa-onnx-linux-${process.arch}`,
  };
  const name = map[process.platform];
  if (name === undefined) {
    fail(`unsupported platform ${process.platform}`);
  }
  return [name];
}

function readPinnedVersion() {
  const pj = JSON.parse(readFileSync(join(GUI_ROOT, "package.json"), "utf8"));
  const v = pj.dependencies?.["sherpa-onnx-node"];
  if (typeof v !== "string") {
    fail("packages/gui/package.json has no sherpa-onnx-node dependency");
  }
  // Exact pin expected (no ^ or ~): the addon and its wrapper must match.
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    fail(`sherpa-onnx-node must be pinned exactly, found "${v}"`);
  }
  return v;
}

function fail(msg) {
  console.error(`\n[stage-tts] ERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * The real directory of an installed package, or null. Walks up from the GUI
 * package so both the workspace root and any nested `node_modules` are seen;
 * `statSync` follows the pnpm symlink to the real `.pnpm` directory.
 */
function findPackage(name) {
  const roots = [
    join(CACHE_DIR, "node_modules", name),
    join(GUI_ROOT, "node_modules", name),
    join(REPO_ROOT, "node_modules", name),
  ];
  for (const r of roots) {
    if (existsSync(join(r, "package.json"))) return r;
  }
  // pnpm's virtual store, where the platform package sits beside the wrapper.
  const store = join(REPO_ROOT, "node_modules", ".pnpm");
  const direct = join(store, `${name}@${VERSION}`, "node_modules", name);
  if (existsSync(join(direct, "package.json"))) return direct;
  return null;
}

/** Fetch a platform package npm refused to install here (cross-arch build). */
function fetchPackage(name) {
  console.log(`[stage-tts] fetching ${name}@${VERSION} (not installed here)`);
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--force", // the package's own os/cpu fields exclude this host
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--prefix",
        CACHE_DIR,
        `${name}@${VERSION}`,
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    fail(`could not fetch ${name}@${VERSION}: ${err.message}`);
  }
  const dir = findPackage(name);
  if (dir === null)
    fail(`fetched ${name} but cannot find it under ${CACHE_DIR}`);
  return dir;
}

function verifyPackage(name, dir) {
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (pj.version !== VERSION) {
    fail(
      `${name} is ${pj.version} but sherpa-onnx-node is pinned at ${VERSION} — ` +
        "the addon and its wrapper must be the same build",
    );
  }
  if (
    name !== "sherpa-onnx-node" &&
    !existsSync(join(dir, "sherpa-onnx.node"))
  ) {
    fail(`${name} has no sherpa-onnx.node — the addon is missing`);
  }
}

function bytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

// ── run ─────────────────────────────────────────────────────────────────────

const wanted = ["sherpa-onnx-node", ...targets()];

if (CHECK_ONLY) {
  let missing = 0;
  for (const name of wanted) {
    const dir = findPackage(name);
    console.log(`[stage-tts] ${name}: ${dir ?? "MISSING"}`);
    if (dir === null) missing += 1;
  }
  const staged = existsSync(STAGE_DIR);
  console.log(
    `[stage-tts] staged: ${staged ? `${(bytes(STAGE_DIR) / 1e6).toFixed(1)} MB at ${STAGE_DIR}` : "no"}`,
  );
  process.exit(missing > 0 ? 1 : 0);
}

rmSync(STAGE_DIR, { recursive: true, force: true });
mkdirSync(STAGE_DIR, { recursive: true });

for (const name of wanted) {
  let dir = findPackage(name);
  if (dir === null) {
    if (name === "sherpa-onnx-node") {
      fail(
        "sherpa-onnx-node is not installed — run pnpm install from the repo root",
      );
    }
    dir = fetchPackage(name);
  }
  verifyPackage(name, dir);
  // `dereference` is the point: pnpm hands back symlinks, and the packaged
  // app must contain real files.
  cpSync(dir, join(STAGE_DIR, name), {
    recursive: true,
    dereference: true,
    // Skip a NESTED node_modules — pnpm puts the platform package there as a
    // symlink back into the store, and each package is staged in its own
    // right, side by side, which is the layout the addon's sibling lookup
    // expects. Judged on the path RELATIVE to the package: every source path
    // is itself under a node_modules, so an absolute-path test excludes
    // everything (it did, silently, and staged an empty tree).
    filter: (src) => {
      const rel = relative(dir, src);
      return rel === "" || !rel.split(sep).includes("node_modules");
    },
  });
  console.log(`[stage-tts] staged ${name} from ${dir}`);
}

console.log(
  `[stage-tts] OK — ${(bytes(STAGE_DIR) / 1e6).toFixed(1)} MB in ${STAGE_DIR}`,
);
