/**
 * Release gate: refuse to package an installer with no voice payload.
 *
 * WHY THIS EXISTS (audit 2026-08-05, B3). `extraResources` in
 * electron-builder.yml copies `../../data/voice/**\/*.opus`. When that glob
 * matches nothing, electron-builder logs one "file source doesn't exist" line
 * and **exits 0** — so a voiceless installer builds, uploads, and becomes the
 * build `latest.yml` advertises. At runtime it fails silently too:
 * voice-path.ts resolves <resources>/voice, clip-list.ts swallows the ENOENT
 * to [], and no category ever fires. Nothing anywhere says "the voice is
 * missing". That shipped once already, against a README that promises
 * "official installer releases include them".
 *
 * The check is deliberately derived, not a magic number:
 *   - every .wav master must have a matching .opus sibling (the transcode is
 *     1:1 — see scripts/transcode-voice.mjs), so adding clips never requires
 *     touching this file;
 *   - and the total must be non-zero, which is the case a pure wav/opus
 *     comparison would happily pass on a tree with neither.
 *
 * Run from packages/gui (the `dist` scripts do). Exits non-zero with an
 * actionable message; `--warn` downgrades to a warning for source builds,
 * which are explicitly allowed to be silent.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const VOICE_ROOT = resolve(process.cwd(), "../../data/voice");
const WARN_ONLY = process.argv.includes("--warn");

/** Every file under `dir` with the given extension, recursively. */
function collect(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, ext, out);
    else if (entry.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out;
}

function fail(lines) {
  const label = WARN_ONLY ? "WARNING" : "ERROR";
  console.error(`\n[voice-payload] ${label}: ${lines[0]}`);
  for (const l of lines.slice(1)) console.error(`  ${l}`);
  console.error("");
  if (!WARN_ONLY) process.exit(1);
}

if (!existsSync(VOICE_ROOT)) {
  fail([
    `no voice tree at ${VOICE_ROOT}`,
    "The installer would ship with no voice clips and degrade silently.",
    "data/voice is gitignored on purpose (HoYoverse-derived, outside the MIT",
    "grant) — copy it onto this machine before building a release.",
  ]);
  process.exit(WARN_ONLY ? 0 : 1);
}

const opus = collect(VOICE_ROOT, ".opus");
const wav = collect(VOICE_ROOT, ".wav");

// A .wav with no .opus sibling means the transcode was never run (or is stale)
// — electron-builder only packs .opus, so those clips would silently vanish.
const missing = wav
  .filter((w) => !existsSync(w.replace(/\.wav$/i, ".opus")))
  .map((w) => relative(VOICE_ROOT, w));

if (opus.length === 0) {
  fail([
    `voice tree has ${wav.length} .wav master(s) but ZERO .opus files`,
    "electron-builder packs only .opus, so this build would be voiceless.",
    "Fix: node scripts/transcode-voice.mjs   (from the repo root)",
  ]);
} else if (missing.length > 0) {
  fail([
    `${missing.length} .wav master(s) have no .opus sibling — those clips will NOT ship`,
    ...missing.slice(0, 8),
    ...(missing.length > 8 ? [`…and ${missing.length - 8} more`] : []),
    "Fix: node scripts/transcode-voice.mjs   (from the repo root)",
  ]);
} else {
  const byCategory = new Map();
  for (const f of opus) {
    const rel = relative(VOICE_ROOT, f);
    const category = rel.split(/[\\/]/)[0];
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  }
  const summary = [...byCategory.entries()]
    .sort()
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");
  console.log(`[voice-payload] OK — ${opus.length} clips (${summary})`);
}
