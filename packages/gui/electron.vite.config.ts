import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { isDeadTranscoderAsset } from "./src/shared/dead-transcoder.js";
import { PRODUCT_PROFILE } from "./src/shared/product-profile.js";

/**
 * Where the bundle manifest lands. Under out/ (gitignored, and what
 * electron-builder packages — so `electron-builder.yml` EXCLUDES this one file
 * from `files:`), because writing anywhere else would need a .gitignore line
 * in both repos, and the public one is hand-owned.
 */
const BUNDLE_MANIFEST = resolve(__dirname, "out/bundle-manifest.json");

/**
 * Record exactly which modules rollup wrote into each bundle (audit BL26 →
 * THIRD-PARTY-NOTICES, 2026-08-16).
 *
 * The notices file has to describe what the INSTALLER ships, and the only
 * honest source for that is the bundler: package.json manifests over-count
 * (better-sqlite3 is a declared dependency and is tree-shaken clean out —
 * that is the packaging invariant CI greps for), and grepping the output for
 * package names under-counts (rollup keeps no names). `generateBundle` sees
 * the truth: every chunk's `modules` map, with `renderedLength` telling a
 * module that contributed code apart from one that survived only as an
 * empty graph node. Modules at 0 are dropped for the same reason CI's grep
 * exists — nothing of them ships.
 *
 * Runs on every build (dev included — harmless, ~ms) and merges per section,
 * so main / preload / renderer each overwrite only their own key.
 * `packages/gui/scripts/third-party-notices.mjs` turns this into the notices
 * file and, with `--check`, fails a release build whose notices are stale.
 */
function bundleManifest(section: "main" | "preload" | "renderer"): Plugin {
  return {
    name: "herta-bundle-manifest",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, info] of Object.entries(output.modules)) {
          if (info.renderedLength > 0) modules.add(id);
        }
      }
      let manifest: Record<string, string[]> = {};
      if (existsSync(BUNDLE_MANIFEST)) {
        try {
          manifest = JSON.parse(readFileSync(BUNDLE_MANIFEST, "utf8"));
        } catch {
          manifest = {};
        }
      }
      manifest[section] = [...modules].sort();
      mkdirSync(dirname(BUNDLE_MANIFEST), { recursive: true });
      writeFileSync(BUNDLE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

/**
 * Drop three's own emitted copy of the Basis transcoder (ADR 0057 §6.5):
 * `KTX2Loader` imports it through `new URL(…, import.meta.url)`, which Vite
 * emits as assets unconditionally, and the scene always sets a
 * `transcoderPath` to the scheme-served copy — so the pair under assets/
 * is 585 KB of dead weight in the asar. The served copy is public/, not an
 * asset, and is untouched.
 */
function dropDeadTranscoder(): Plugin {
  return {
    name: "herta-drop-dead-transcoder",
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (isDeadTranscoderAsset(name)) delete bundle[name];
      }
    },
  };
}

/**
 * Emit the neural-voice worker beside the main bundle, verbatim (ADR 0042).
 *
 * `src/main/tts/tts-worker.cjs` is deliberately NOT part of the bundle: it
 * `require`s the native `sherpa-onnx-node` addon, which rollup cannot bundle
 * (and must not try to — the whole packaging invariant is that `out/main`
 * references no native code). The coordinator forks it by absolute path
 * (`join(__dirname, "tts-worker.cjs")`), so it has to exist as a real file
 * next to `out/main/index.js`. `comm-channel-effect.cjs` (the terminal
 * treatment, vendored from the voice repo) rides along the same way: the
 * worker requires it as a sibling, so it must be a real file beside it.
 *
 * Copied through `emitFile` rather than a static `publicDir` so a missing
 * source file fails the BUILD loudly instead of producing an app whose voice
 * silently never starts.
 */
function ttsWorker(): Plugin {
  const files = [
    "tts-worker.cjs",
    "comm-channel-effect.cjs",
    "sherpa-punctuation.cjs",
  ];
  return {
    name: "herta-tts-worker",
    generateBundle() {
      for (const name of files) {
        const src = resolve(__dirname, "src/main/tts", name);
        if (!existsSync(src)) {
          this.error(`tts worker file missing at ${src}`);
          return;
        }
        this.emitFile({
          type: "asset",
          fileName: name,
          source: readFileSync(src, "utf8"),
        });
      }
    },
  };
}

export default defineConfig({
  // Main + preload BUNDLE their entire dependency graph (packaging strategy,
  // 2026-07-06): the former externalizeDepsPlugin left @herta/* as runtime
  // requires, which would force the installer to ship a pnpm node_modules
  // tree. Bundling makes out/ self-contained — and with the workspace libs
  // marked sideEffects:false, rollup tree-shakes the only native-dependency
  // branch (knowledge's SqliteKnowledgeStore → better-sqlite3, unreferenced
  // since the lore tools were removed) clean out of the bundle: the packaged
  // app ships NO node_modules and NO native modules. electron + node
  // builtins stay external automatically.
  main: {
    plugins: [
      bundleManifest("main"),
      ...(PRODUCT_PROFILE.voice ? [ttsWorker()] : []),
    ],
    build: { outDir: "out/main", rollupOptions: {
      input: { index: resolve(__dirname, "src/main/index.ts"), "chat-storage-worker": resolve(__dirname, "src/main/chat-storage-worker.ts") },
      output: { entryFileNames: "[name].js" },
    } },
  },
  preload: {
    plugins: [bundleManifest("preload")],
    build: {
      outDir: "out/preload",
      // CJS, explicitly (audit T3.6): the package is type:module, so
      // electron-vite would emit the preload as ESM (index.mjs) — and a
      // SANDBOXED renderer only loads CJS preload scripts; the .mjs preload
      // silently fails to attach and window.herta comes up undefined. The
      // preload bundles self-contained, so CJS costs nothing.
      rollupOptions: { output: { format: "cjs" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), dropDeadTranscoder(), bundleManifest("renderer")],
    build: {
      outDir: "out/renderer",
      // electron-vite's renderer default is `minify: false` (it is Vite's
      // that minifies) — the app had shipped 15.7 MB of readable JS: a
      // 928 KB entry the window parses before its first paint, a 2.6 MB
      // scene chunk (perf audit 2026-09-20). JS only: the stylesheet stays
      // byte-for-byte what was authored — its masks, fallback declarations
      // and `-webkit-` pairs were tuned by eye, and a minifier's merges are
      // not worth re-checking every surface for ~100 KB. Main and preload
      // stay readable: a stack trace from a user's log has to name things.
      minify: "esbuild",
      cssMinify: false,
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
