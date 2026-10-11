/**
 * Personal build gate. Run after electron-vite + the notices check.
 * Optional --unpacked <win-unpacked> inspects the actual archive/resources.
 * This is payload validation; it does not claim a desktop or installer passed.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GUI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(GUI, "../..");
const failures = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = (name) => name.replaceAll("\\", "/");
const mapleHashes = new Set([
  "e7080ef37fa8b3a38f71446e53e546634c27ce2cfe97673478cafc029d6344ee",
  "6ee68f909d35b832b804649c8ddf2baadac0c00a035294b2b0eeef95990641ef",
]);
const mapleLicenseHash =
  "eb2d28d2e565a0757e3d64e34ebb452e75a0cad87c0ab3faF4e08ba7596de902".toLowerCase();
function checkMapleLicense(path) {
  if (requireFile(path) && sha256(readFileSync(path)) !== mapleLicenseHash)
    failures.push(`Maple Mono license hash mismatch: ${relative(ROOT, path)}`);
}
function requireMapleFonts(hashes, scope) {
  for (const hash of mapleHashes)
    if (!hashes.has(hash))
      failures.push(`fixed Maple Mono font missing: ${scope}`);
}

// Unapproved upstream artwork at fixed commit 8fb8099. Catch renamed copies
// as well as emitted names. Personal geometry has separate provenance.
const upstreamArtwork = new Set([
  "d20901f82c2863a3513b7b1b8c41dd8c0b6135b8b32d44ba2dafe24c2b9dec51",
  "12c04e1878b8424bba257c7937d80af46ee369f036781ab680b95f4e5cd165d4",
  "d146028b4f0238fc1c2cf52e73b4f8534479cf52d75c065bbaf2c1aac26539e5",
  "f0b79c08cfcc8159873cd9e188971fda747d795d4407fd69231746220c992d58",
  "fca7821e503d876a574c6d660d450231e0def176279b5d605f0527909b98daa2",
  "7a391d072b8af23b10dc43b944511a70ea9303980beb9d48c73f6b654d2a23cc",
  "d108b577961f68935af8eebea0c641fabd19d48b206d294ca287ef52f18b2499",
  "46b7da34853b4d5091a364bde205443c087acf12e8ef3d8d8e3cb4701267b6aa",
  "b9038d8bb064884f14559167cc848860934320e0de4cc4701504ad7b4a2292b9",
  "a12b6f010d35bc953aa3e69697fa03ce95f8393a123f6d5de2ee82dde94ef1e5",
  "0a2bb237484dcd9c615d2352d99f67e014c731f546d64fc143da0865577cb661",
  "7183b166415df304856c4bb5223444617e596c8238e696bcf8d64a96bc093780",
  "2ddb06d6bb37eba3e1fbe561ee33c3febae3132ee8a0660050d9e46fa389d50d",
  "58fd53a0f25fb2e356972545bbf006d39a350e418843ef82d98f419268874a17",
  "649f5f1e4dfa190b65085e214aff8d37938da1a12911c564f07e651d6d9514ae",
]);
const forbiddenName =
  /(?:^|\/)(?:device-scene|upstream-assets|voice|voice-clone|tts-runtime)(?:\/|$)|(?:tts-worker|comm-channel-effect|sherpa-punctuation)\.cjs$|(?:default-herta|default-trailblazer|agent_|earth-icon|herta-station-icon|UX_v5|OpeningAscii|opening-)[^/]*$|\.(?:opus|wav|mp3|glb|gltf|ktx2|onnx)$/i;
const raster = /\.(?:png|jpe?g|webp|gif|ico)$/i;

function requireFile(path) {
  if (
    !existsSync(path) ||
    !statSync(path).isFile() ||
    statSync(path).size === 0
  ) {
    failures.push(`required file missing or empty: ${relative(ROOT, path)}`);
    return false;
  }
  return true;
}

function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink()) {
      failures.push(`symlink in payload: ${relative(ROOT, path)}`);
    } else if (item.isDirectory()) {
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}

function checkEntry(name, bytes) {
  const normalized = posix(name);
  if (forbiddenName.test(normalized))
    failures.push(`optional/unapproved payload: ${normalized}`);
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|(?:keys|settings|app-settings|provider-settings|global-settings|provider-migration)\.json|sessions?\.jsonl)$/.test(
      normalized,
    )
  ) {
    failures.push(
      `local configuration or transcript in payload: ${normalized}`,
    );
  }
  if (
    /(?:^|\/)(?:\.herta|\.verification|transcripts|test-profile|credentials)(?:\/|$)/i.test(
      normalized,
    )
  ) {
    failures.push(`verification or personal data in payload: ${normalized}`);
  }
  if (/\.(?:[cm]?js|json|html|css|txt|md)$/i.test(normalized)) {
    // Report paths only; never echo a matching credential value.
    if (/\bsk-[A-Za-z0-9_-]{24,}\b/.test(bytes().toString("utf8"))) {
      failures.push(
        `possible plaintext API credential in payload: ${normalized}`,
      );
    }
  }
  if (raster.test(normalized) && upstreamArtwork.has(sha256(bytes()))) {
    failures.push(`unapproved upstream image hash: ${normalized}`);
  }
}

for (const name of [
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "assets/ASSET_MANIFEST.md",
  "docs/ASSET_AUDIT.md",
])
  requireFile(join(ROOT, name));
for (const name of [
  "out/main/index.js",
  "out/preload/index.cjs",
  "out/renderer/index.html",
  "out/bundle-manifest.json",
  "resources/herta-icon.png",
  "build/icon.png",
  "build/icon.ico",
  "resources/licenses/atelier-geometric-LICENSE.txt",
])
  requireFile(join(GUI, name));

const configPath = join(GUI, "electron-builder.personal.yml");
if (requireFile(configPath)) {
  const config = readFileSync(configPath, "utf8");
  if (
    !/^appId: personal\.herta\.atelier$/m.test(config) ||
    !/^productName: The Herta$/m.test(config)
  ) {
    failures.push(
      "personal appId/productName do not match the frozen product profile",
    );
  }
  if (
    !/^publish: null$/m.test(config) ||
    /^\s*(?:provider: github|owner: PersonaCLI|repo: Herta)$/m.test(config)
  ) {
    failures.push(
      "personal configuration must not carry an upstream publication/update feed",
    );
  }
  if (/^\s*- from:.*(?:data\/voice|tts-runtime)/m.test(config))
    failures.push("voice/TTS extraResources enabled");
}

walk(join(GUI, "out"), (path) =>
  checkEntry(relative(GUI, path), () => readFileSync(path)),
);
checkMapleLicense(join(GUI, "resources/licenses/MapleMono-OFL.txt"));
const builtFonts = new Set();
walk(join(GUI, "out/renderer"), (path) => {
  if (path.endsWith(".woff2")) builtFonts.add(sha256(readFileSync(path)));
});
requireMapleFonts(builtFonts, "renderer output");
for (const name of [
  "resources/herta-icon.png",
  "build/icon.png",
  "build/icon.ico",
]) {
  const path = join(GUI, name);
  if (existsSync(path)) checkEntry(name, () => readFileSync(path));
}

const unpackedFlag = process.argv.indexOf("--unpacked");
if (unpackedFlag !== -1) {
  const argument = process.argv[unpackedFlag + 1];
  if (!argument || argument.startsWith("--")) {
    failures.push("--unpacked requires the win-unpacked directory");
  } else {
    const unpacked = resolve(argument);
    const resources = join(unpacked, "resources");
    checkMapleLicense(join(resources, "licenses/MapleMono-OFL.txt"));
    requireFile(join(unpacked, "The Herta.exe"));
    requireFile(join(unpacked, "LICENSE.electron.txt"));
    requireFile(join(unpacked, "LICENSES.chromium.html"));
    for (const name of [
      "LICENSE",
      "THIRD-PARTY-NOTICES.md",
      "ASSET_MANIFEST.md",
      "ASSET_AUDIT.md",
      "licenses/atelier-geometric-LICENSE.txt",
    ]) {
      requireFile(join(resources, name));
    }
    if (existsSync(join(resources, "app-update.yml")))
      failures.push("packaged app contains an automatic-update feed");
    walk(resources, (path) => {
      if (!path.endsWith("app.asar"))
        checkEntry(relative(unpacked, path), () => readFileSync(path));
    });
    const archive = join(resources, "app.asar");
    if (requireFile(archive)) {
      try {
        // Resolve an already locked electron-builder dependency through its
        // owner; no extra package installation or lockfile change is needed.
        const require = createRequire(import.meta.url);
        const builderRequire = createRequire(
          require.resolve("electron-builder/package.json"),
        );
        const appBuilderRequire = createRequire(
          builderRequire.resolve("app-builder-lib/package.json"),
        );
        const asar = appBuilderRequire("@electron/asar");
        const entries = asar.listPackage(archive);
        const packedFonts = new Set();
        for (const name of entries) {
          const nativeFile = name.replace(/^[\\/]/, "");
          const file = posix(name).replace(/^\//, "");
          if (asar.statFile(archive, nativeFile).files) continue;
          checkEntry(file, () => asar.extractFile(archive, nativeFile));
          if (file.endsWith(".woff2"))
            packedFonts.add(sha256(asar.extractFile(archive, nativeFile)));
        }
        requireMapleFonts(packedFonts, "app.asar");
        console.log(
          `[personal-payload] inspected ${entries.length} archive entries at ${unpacked}`,
        );
      } catch (error) {
        failures.push(
          `archive inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `[personal-payload] FAILED (${failures.length})\n${failures.map((line) => `  ${line}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  "[personal-payload] PASS: personal identity, notices, geometry provenance, and absence of voice/TTS/3D/upstream artwork payload",
);
