/**
 * Report (and optionally require) the neural-voice RUNTIME before packaging,
 * and refuse a build that would carry the MODEL.
 *
 *   node scripts/check-tts-payload.mjs            # report; never fails
 *   node scripts/check-tts-payload.mjs --strict   # missing runtime = failure
 *   … --expect sherpa-onnx-linux-x64[,…]          # EXACTLY these addons
 *
 * `--expect` fails in every mode (platform review 2026-09-23): a runtime for
 * the WRONG platform is not "no voice, degrade quietly" — it is a build that
 * says it has a voice and cannot load it. The Linux build staged the host's
 * platform, so a build run after `pnpm dist` on the same tree packed the
 * win-x64 addon into the AppImage and every check passed.
 *
 * WHY (the B3 lesson, applied ahead of time). `extraResources` entries whose
 * source does not exist make electron-builder log one line and exit 0 — so a
 * voiceless build packages, uploads, and becomes the release, and at runtime
 * it fails silently too: the synthesizer reports unavailable and every reply
 * simply types. That is a legitimate build (an install without the runtime
 * is supposed to degrade quietly), which is exactly why it needs SAYING at
 * build time rather than being discovered by a user who expected a voice.
 *
 * The MODEL is the other way round (ADR 0061, owner 2026-09-08): it is a
 * download, never an installer payload, so a `data/tts` entry in
 * electron-builder.yml is a mistake this script fails on in every mode —
 * the installer would double in size without anyone having decided that.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(HERE, "..");
const STAGE_DIR = join(GUI_ROOT, "tts-runtime");
const BUILDER_CONFIG = join(GUI_ROOT, "electron-builder.yml");
const STRICT = process.argv.includes("--strict");
const expectIx = process.argv.indexOf("--expect");
const EXPECT =
  expectIx >= 0
    ? (process.argv[expectIx + 1] ?? "").split(",").filter(Boolean).sort()
    : null;

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

// ── the model must NOT be in the installer ──────────────────────────────────
const builder = readFileSync(BUILDER_CONFIG, "utf8");
const modelEntry = builder
  .split("\n")
  .find((line) => /^\s*-\s*from:\s*.*data\/tts\b/.test(line));
if (modelEntry !== undefined) {
  console.error(
    "\n[tts-payload] ERROR: electron-builder.yml stages the voice MODEL " +
      `(${modelEntry.trim()}). The model is a download (ADR 0061), not an ` +
      "installer payload — remove the entry.\n",
  );
  process.exit(1);
}

// ── the runtime should be staged ────────────────────────────────────────────
const problems = [];
if (!existsSync(STAGE_DIR)) {
  problems.push(
    `no staged native runtime at ${STAGE_DIR} — run: node scripts/stage-tts.mjs`,
  );
} else if (!existsSync(join(STAGE_DIR, "sherpa-onnx-node", "sherpa-onnx.js"))) {
  problems.push("staged runtime has no sherpa-onnx-node");
} else {
  const addons = readdirSync(STAGE_DIR).filter((n) =>
    existsSync(join(STAGE_DIR, n, "sherpa-onnx.node")),
  );
  if (addons.length === 0) {
    problems.push("staged runtime has no platform addon (sherpa-onnx.node)");
  }
  if (EXPECT !== null && addons.sort().join(",") !== EXPECT.join(",")) {
    console.error(
      `\n[tts-payload] ERROR: the staged addons are [${addons.join(", ")}] but ` +
        `this build needs exactly [${EXPECT.join(", ")}] — a runtime for another ` +
        "platform cannot load. Re-stage with the matching flag " +
        "(node scripts/stage-tts.mjs --win | --mac | --linux).\n",
    );
    process.exit(1);
  }
}

// ── the clone's reference (ADR 0062) — a notice, never a failure ──────────
const REFERENCE = resolve(
  GUI_ROOT,
  "../../data/voice-clone/herta-reference.wav",
);
if (!existsSync(REFERENCE)) {
  console.error(
    "[tts-payload] NOTICE: no data/voice-clone/herta-reference.wav — the MiniMax " +
      "clone row will report the reference missing (scripts/minimax-voice-lab.mjs merge).",
  );
}

if (problems.length === 0) {
  const runtime = (dirBytes(STAGE_DIR) / 1e6).toFixed(1);
  const addons = readdirSync(STAGE_DIR)
    .filter((n) => existsSync(join(STAGE_DIR, n, "sherpa-onnx.node")))
    .join(", ");
  console.log(
    `[tts-payload] OK — runtime ${runtime} MB (${addons}); the model is a download, not staged`,
  );
  process.exit(0);
}

const label = STRICT ? "ERROR" : "NOTICE";
console.error(
  `\n[tts-payload] ${label}: this build will ship WITHOUT the voice runtime.`,
);
for (const p of problems) console.error(`  - ${p}`);
console.error(
  "  Herta will still run; every reply types at the read-along pace, and\n" +
    "  the Settings → Voice model row says the runtime is missing.\n" +
    "  To include it: node scripts/stage-tts.mjs  (see ADR 0042 §5)\n",
);
process.exit(STRICT ? 1 : 0);
