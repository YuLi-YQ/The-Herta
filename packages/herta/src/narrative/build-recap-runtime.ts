import type { ProviderAdapter } from "@herta/core";
import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";
import {
  deleteRecapCache,
  readRecapCache,
  writeRecapCache,
} from "./recap-cache.js";
import { DEFAULT_COMPACTION_CONFIG } from "./session-recap.js";
import {
  makeRecapSummarize,
  type RecapRuntime,
} from "./session-recap-runtime.js";

export interface BuildRecapRuntimeOpts {
  /** Chat-mode provider — drives the recap summarizer. Since the router
   *  dropped to thinking:"low" (2026-08-03), callers pass the SUPERVISOR's
   *  "high" flash adapter here, not the router's: recap distills voice
   *  anchors and rolls (ADR 0009), which is precision work. The historical
   *  param name is kept to avoid a cross-package rename. */
  readonly routerProvider: ProviderAdapter;
  /** Workspace root: anchors the recap sidecar cache. */
  readonly workspaceRoot: string;
  /** Session id: keys the recap cache file. */
  readonly sessionId: string;
  /** Whether automatic threshold compaction is on. Default `false`
   *  (wired-but-default-off; manual /compact bypasses this gate). */
  readonly enabled?: boolean;
  /** Interaction language: selects the compiled prompt bundle for the
   *  guide/bio voice anchors and the recap's LLM-facing prose (summarizer
   *  instructions, elision notes, placeholder recaps) — becomes
   *  `RecapRuntime.lang`. Default "zh", byte-identical. */
  readonly lang?: PromptLang;
}

/**
 * Construct the per-session `RecapRuntime` for long-session compaction
 * (spec 2026-06-19, ADR 0009). Shared by the CLI (`packages/cli/src/app/main.ts`)
 * and app-server (`packages/app-server/src/session.ts`) bootstraps so the config
 * cannot drift between the two call sites.
 *
 * The 黑塔 recap guide (HertaGuide) and the bounded head excerpt of the
 * autobiography (HertaBio — a first-person voice anchor) come from the
 * COMPILED per-lang prompt bundle (`promptAssetsFor`), the same identity
 * source as the static prefix (M-prompts-1 / D1: identity lives in the
 * harness, not in workspace files). They were originally read from the
 * workspace `.herta/narrative*` dir — but M-prompts-1 moved the files out
 * of the workspace, so those reads silently returned "" in every real
 * session; the live recap lab caught it (2026-07-17). `enabled` defaults
 * to `false` for direct/test callers, but BOTH app bootstraps pass
 * `enabled: true` — automatic compaction is live, engaging at the
 * chat-first working-set threshold (~200K estimated tokens, ADR 0009
 * amendment 2026-07-17). The manual `/compact` path (CLI only — the GUI
 * deliberately has no manual trigger; compaction is invisible
 * infrastructure there) bypasses `enabled` either way.
 */
export async function buildRecapRuntime(
  opts: BuildRecapRuntimeOpts,
): Promise<RecapRuntime> {
  const {
    routerProvider,
    workspaceRoot,
    sessionId,
    enabled = false,
    lang = "zh",
  } = opts;
  const config = { ...DEFAULT_COMPACTION_CONFIG, enabled };
  const assets = promptAssetsFor(lang);
  // A head excerpt (序 + the self-intro) — a voice anchor, not the whole bio.
  const bio =
    config.maxBioChars > 0 ? assets.hertaBio.slice(0, config.maxBioChars) : "";
  return {
    config,
    guide: assets.hertaGuide,
    bio,
    lang,
    summarize: makeRecapSummarize(routerProvider),
    cacheRead: () => readRecapCache(workspaceRoot, sessionId),
    cacheWrite: (c) => writeRecapCache(workspaceRoot, sessionId, c),
    cacheInvalidate: () => deleteRecapCache(workspaceRoot, sessionId),
    consecutiveFailures: 0,
    skippedWhileOpen: 0,
  };
}
