/**
 * Transcode the local voice corpus `data/voice/**\/*.wav` into Opus siblings
 * (`<same stem>.opus`, Ogg container) — the format the app ships and plays
 * since 2026-07-16 (installer size: 17 MB of PCM → ~2 MB of Opus; the wavs
 * stay on disk as the gitignored source masters and are excluded from the
 * package by electron-builder's extraResources filter).
 *
 * Usage:  node scripts/transcode-voice.mjs [--force]
 *   ffmpeg is resolved from (in order) the FFMPEG env var, PATH, or a local
 *   `ffmpeg-static` install if one is resolvable. Existing .opus files are
 *   skipped unless --force.
 *
 * Encoding: libopus 64 kbps VBR (application audio). The clips are 32 kHz
 * mono PCM voice lines; 64k VBR is transparent for speech with headroom for
 * the expressive lines, and Opus resamples to its native 48 kHz internally.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const voiceRoot = join(repoRoot, "data", "voice");
const force = process.argv.includes("--force");

async function resolveFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  for (const candidate of ["ffmpeg", "ffmpeg.exe"]) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // not on PATH — keep looking
    }
  }
  try {
    const { createRequire } = await import("node:module");
    return createRequire(import.meta.url)("ffmpeg-static");
  } catch {
    return null;
  }
}

function* walkWavs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkWavs(p);
    else if (/\.wav$/i.test(entry.name)) yield p;
  }
}

const ffmpeg = await resolveFfmpeg();
if (ffmpeg === null) {
  console.error(
    "transcode-voice: no ffmpeg found (set FFMPEG=<path>, put ffmpeg on PATH, or `npm i ffmpeg-static` somewhere resolvable)",
  );
  process.exit(2);
}

let done = 0;
let skipped = 0;
for (const wav of walkWavs(voiceRoot)) {
  const opus = wav.replace(/\.wav$/i, ".opus");
  if (!force) {
    try {
      if (statSync(opus).size > 0) {
        skipped += 1;
        continue;
      }
    } catch {
      // no .opus yet — transcode it
    }
  }
  execFileSync(
    ffmpeg,
    ["-y", "-i", wav, "-c:a", "libopus", "-b:a", "64k", "-vbr", "on", opus],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  done += 1;
}
console.log(`transcode-voice: ${done} transcoded, ${skipped} up to date`);
