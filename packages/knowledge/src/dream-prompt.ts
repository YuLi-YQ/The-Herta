/**
 * `@herta/knowledge/dream-prompt` — the three things a PROMPT needs of Dream,
 * and nothing else of this package.
 *
 * The runtime wiring (`@herta/app-server/wiring`) reads Dream's manifest to
 * decide which of a session's own dreams to keep out of its prefix (the
 * reopen filter). It imported them from the package root, and the root is
 * everything: the ingest pipeline, the voice tooling, the SQLite store and
 * its native addon. Measured cold, 2026-09-21: the root costs ~550 ms to
 * import, these files ~80 ms (most of that `@herta/core`, which the caller
 * loads anyway). The desktop app never paid it — its bundler tree-shakes the
 * root down to what is used — but the CLI is not bundled and paid it on
 * every start, before its first prompt.
 *
 * Keep this entry NARROW: anything added here is loaded by every host at
 * boot. A guard test walks its import graph and fails on the heavy modules.
 */
export { resolveDreamConfig } from "./dream/config.js";
export { readManifest } from "./dream/manifest.js";
export { selectPromptExclusions } from "./dream/prompt-exclusions.js";
export type { DreamConfig, DreamManifest } from "./dream/types.js";
